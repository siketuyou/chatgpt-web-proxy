// browser.js
const fs = require("fs");
const puppeteer = require("puppeteer");

// ---------- 配置 ----------
const COOKIES_PATH = process.env.COOKIES_PATH || "./cookies.json";
const CHAT_URL = process.env.CHAT_URL || "https://chatgpt.com/";
const PROJECT_LINK = process.env.PROJECT_LINK || '/g/g-p-6879204074488191b4d06d1b76b5696f-game/project';
const HEADLESS = String(process.env.HEADLESS || "false").toLowerCase() === "true";
const SLOW_MO = Number(process.env.SLOW_MO || 5);

let browser, page;

// ---------- 错误类型 ----------
class ApiError extends Error {
  constructor(message, { type = "server_error", code = null, status = 500, param = null, details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.type = type;
    this.code = code;
    this.status = status;
    this.param = param;
    this.details = details;
  }
}

// ---------- 工具 ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function readCookiesSafe() {
  try {
    return JSON.parse(fs.readFileSync("./cookies.json", "utf-8"));
  } catch {
    console.warn("⚠️ cookies.json 未找到或解析失败，跳过设置 cookies");
    return [];
  }
}

async function clickElement(selector) {
  await page.waitForSelector(selector, { visible: true });
  const element = await page.$(selector);
  if (!element) {
    throw new ApiError(`Element not found: ${selector}`, {
      type: "server_error",
      code: "selector_not_found",
      status: 500,
      param: selector,
    });
  }
  await element.click();
  console.log(`✅ 点击: ${selector}`);
}
async function retryUntilSuccess(fn, { retries = 5, delay = 300, label = "operation" } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      console.warn(`⚠️ [${label}] 第 ${i + 1} 次失败：${error.message}`);
      if (i === retries - 1) {
        throw new Error(`❌ [${label}] 重试 ${retries} 次失败：${error.message}`);
      }
      await sleep(delay);
    }
  }
}
// ---------- 启动浏览器 ----------
async function initBrowser() {
  browser = await puppeteer.launch({
    headless: false,
    slowMo: 5,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--no-zygote",
      "--disable-software-rasterizer",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-networking",
    ].filter(Boolean),
    defaultViewport: null,
  });

  page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const cookies = readCookiesSafe();
  if (cookies.length) await page.setCookie(...cookies);

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
  );

  await page.goto("https://chatgpt.com/", { waitUntil: "networkidle2", timeout: 120000 });
  await page.waitForSelector("textarea", { timeout: 60000 });
  console.log("✅ ChatGPT 页面加载完成");
}

// ---------- 保活 ----------
async function ensureBrowserReady() {
  const needsRestart = !browser || !browser.process?.() || !page || page.isClosed?.();
  if (needsRestart) {
    console.log("🔄 浏览器无效，重新初始化...");
    await initBrowser();
  }
}

// ---------- 发送消息主流程 ----------
async function sendMessage(messages) {
  await ensureBrowserReady();
  await newAndInputFocus();

  // 拼接消息历史
  const fullMessage = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");


  await typeIntoPrompt(fullMessage);

  await waitForResponseComplete({ idleMs: 1200, timeoutMs: 60000 });
  // 提取最新回复
  const reply = await getLastReply();
  if (!reply || reply.startsWith("⚠️")) {
    throw new ApiError("Empty or invalid reply captured", {
      type: "server_error",
      code: "invalid_reply",
      status: 502,
    });
  }
  return reply;
}

// ---------- 抓取最后一条回复 ----------
async function getLastReply() {
  const MAX_RETRIES = 10;
  const DELAY_MS = 2000;
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      const responses = await page.$$eval("div.markdown", (divs) =>
        divs
          .map((d) => {
            // 清理无关 UI
            d.querySelectorAll(
              ".flex.items-center.text-token-text-secondary.px-4.py-2.text-xs.font-sans.justify-between.h-9.bg-token-sidebar-surface-primary.select-none.rounded-t-2xl, .flex.gap-1.items-center.select-none.py-1, .flex.items-center.gap-1.py-1.select-none"
            ).forEach((el) => el.remove());

            // 将「可滚动容器」内容包成 ``` 代码块，避免样式噪声
            d.querySelectorAll(".overflow-y-auto.p-4").forEach((el) => {
              el.innerText = `\`\`\`\n${el.innerText.trim()}\n\`\`\``;
            });

            return d.innerText.trim();
          })
          .filter(Boolean)
      );

      const reply = responses.at(-1);
      if (reply) return reply;

      throw new Error("no reply yet");
    } catch {
      retries++;
      await sleep(retries === 1 ? 300 : DELAY_MS);
    }
  }

  throw new ApiError("Failed to capture reply after retries", {
    type: "server_error",
    code: "capture_reply_failed",
    status: 504,
  });
}

// ---------- 等待生成结束（基于语音按钮恢复可用） ----------
async function waitForResponseComplete({ idleMs = 1200, timeoutMs = 60000 } = {}) {
  const startTime = Date.now();

  // ① 先等麦克风按钮可用
  while (Date.now() - startTime < timeoutMs) {
    const speechButton = await page.$('[data-testid="composer-speech-button"]');
    if (speechButton) {
      const [isDisabled, isVisible] = await speechButton.evaluate(btn => {
        const style = window.getComputedStyle(btn);
        return [btn.disabled, style.visibility !== 'hidden' && style.display !== 'none'];
      });
      if (!isDisabled && isVisible) break;
    }
    await sleep(300);
  }

  // ② 再等文字稳定
  let lastText = '';
  let lastChangeTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const currentText = await page.$$eval("div.markdown", divs => {
      const last = divs.at(-1);
      return last ? last.innerText.trim() : '';
    });

    if (currentText !== lastText) {
      lastText = currentText;
      lastChangeTime = Date.now();
    }

    if (Date.now() - lastChangeTime >= idleMs) {
      console.log('🟢 回复完成且稳定');
      return;
    }

    await sleep(300);
  }

  throw new ApiError("Response not completed in time", {
    type: "server_error",
    code: "response_timeout",
    status: 504,
  });
}



// ---------- 打开指定项目对话并聚焦输入 ----------
async function clickNewProjectChat() {
  const newChatSelector = `a[href="${PROJECT_LINK}"]`;
  await page.waitForSelector(newChatSelector, { timeout: 30_000 });
  const el = await page.$(newChatSelector);
  if (!el) {
    throw new ApiError("Project chat link not found", {
      type: "server_error",
      code: "project_link_missing",
      status: 500,
      param: PROJECT_LINK,
    });
  }
  await el.click();
  console.log("✅ 进入项目对话");
}

async function focusPromptArea() {
  const selector = '#prompt-textarea';
  try {
    // 2) 只等元素出现，不再等导航，避免卡死
    await page.waitForSelector(selector, { visible: true, timeout: 30000 });
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el && el.scrollIntoView({ block: 'center' });
    }, selector);
    await page.focus(selector);
  } catch (error) {
    console.error('出现错误:', error.message);
  }
}
async function typeIntoPrompt(text) {
  const selector = '#prompt-textarea';
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('prompt textarea not found');

    const setValue = (node, value) => {
      const proto = node.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement?.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(node, value);
      else node.value = value; // 兜底
    };

    if (el instanceof HTMLTextAreaElement) {
      setValue(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      setValue(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange(el.value.length, el.value.length);
    } else {
      // contenteditable 兜底
      el.textContent = val;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val }));
    }
  }, selector, text);
  await page.keyboard.press('Enter');
}
async function newAndInputFocus(maxRetries = 3, delay = 2000) {
  let attempts = 0;
  while (attempts < maxRetries) {
    try {
      await clickNewProjectChat();
      await focusPromptArea();
      return;
    } catch (err) {
      attempts++;
      console.warn(`进入项目对话失败，重试 ${attempts}/${maxRetries}：`, err?.message || err);
      if (attempts >= maxRetries) {
        throw new ApiError("Failed to enter project chat", {
          type: "server_error",
          code: "enter_project_failed",
          status: 502,
          details: String(err?.message || err),
        });
      }
      await sleep(delay);
    }
  }
}
async function waitForResponseStable({ idleMs = 1200, timeoutMs = 45000 } = {}) {
  const start = Date.now();
  await page.waitForSelector('div.markdown', { visible: true, timeout: timeoutMs });
  let last = '';
  let lastChange = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('div.markdown'));
      const last = nodes[nodes.length - 1];
     return last ? last.innerText : '';
    });
    if (current !== last) {
     last = current;
      lastChange = Date.now();
    }
    if (Date.now() - lastChange >= idleMs) return true;
    await sleep(250);
  }
}
// ---------- 删除当前会话（你原有逻辑保留并稳一点） ----------
async function deleteCurrentChat(mode = 1) {
  try {
    if (mode === 1) {
      await page.goto(`${CHAT_URL.replace(/\/$/, "")}${PROJECT_LINK}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(
        "#thread > div > div.relative.flex.basis-auto.flex-col.grow > div > div > div > div.mt-8.mb-14.contain-inline-size",
        { timeout: 30_000 }
      );
      await sleep(500);
    }

    // 定位对话项
    const itemSel = ".group.relative.flex.flex-col.gap-1.p-3";
    await page.waitForSelector(itemSel, { timeout: 30_000 });
    const targetItem = await page.$(itemSel);
    if (!targetItem) return;

    await targetItem.hover();
    await sleep(200);

    // 菜单 -> 删除 -> 确认
    const menuButton = await targetItem.$("button svg.icon");
    if (!menuButton) return;
    await menuButton.click();
    await clickElement('[data-testid="delete-chat-menu-item"]');
    await clickElement('[data-testid="delete-conversation-confirm-button"] > div');

    console.log("🗑️ 对话已删除");
  } catch (err) {
    console.warn("删除会话失败（非致命）：", err?.message || err);
  }
}

// ---------- 进入临时聊天 ----------
async function enterTemporaryChat() {
  const homeSelector = 'a[href="/"]';
  // 1. 回到主页
  await page.click(homeSelector);

  // 2. 等待按钮上层容器
  await page.waitForSelector('#conversation-header-actions', { visible: true, timeout: 10000 });
  // 3. 点右上角“开启/关闭临时聊天”按钮（aria-label 含“临时聊天”）
  const toggleSel = '#conversation-header-actions button[aria-label*="临时聊天"]';
  await page.waitForSelector(toggleSel, { visible: true, timeout: 10000 });
  await page.click(toggleSel);


  // 4. 等待输入框可用
  await retryUntilSuccess(
    async () => {
      await page.waitForSelector("#prompt-textarea", { visible: true, timeout: 5000 });
    },
    { retries: 5, delay: 500, label: "wait temp chat textarea" }
  );

  console.log("✅ 进入临时聊天");
}

// ---------- 删除临时聊天 ----------
async function deleteTemporaryChat() {
  try {
  delButtonSel = 'conversation-options-button';
  await page.waitForSelector(delButtonSel, { visible: true, timeout: 10000 });
  await page.click(toggleSel);
    // 点击菜单里的删除
    await clickElement('[data-testid="delete-chat-menu-item"]');
    await clickElement('[data-testid="delete-conversation-confirm-button"] > div');

    console.log("🗑️ 临时聊天已删除");
  } catch (err) {
    console.warn("⚠️ 删除临时聊天失败（非致命）：", err?.message || err);
  }
}

//临时信息处理
async function sendTemperaryMessage(messages) {
  await ensureBrowserReady();

  // 1. 进入临时聊天
  await enterTemporaryChat();

  // 2. 拼接消息历史
  const fullMessage = messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n");

  // 3. 输入消息
  await retryUntilSuccess(
    async () => {
      await typeIntoPrompt(fullMessage);
    },
    { retries: 3, delay: 300, label: "fill temp chat textarea" }
  );

  // 4. 等待生成完成
  await waitForResponseComplete({ idleMs: 1200, timeoutMs: 60000 });

  // 5. 提取最后一条回复
  const reply = await getLastReply();
  if (!reply || reply.startsWith("⚠️")) {
    throw new ApiError("Empty or invalid reply captured", {
      type: "server_error",
      code: "invalid_reply",
      status: 502,
    });
  }
  return reply;
}

// ---------- 其它辅助 ----------
async function reloadPage(options = { waitUntil: "domcontentloaded" }) {
  if (!page) throw new ApiError("Page is not defined");
  await page.reload(options);
}

async function deleteAllChat() {
  try {
    await page.goto("https://chat.openai.com/chat", { waitUntil: "domcontentloaded" });
    await clickElement(`a[href="${PROJECT_LINK}"]`);
    await sleep(2000);
    await page.waitForSelector(".group.relative.flex.flex-col.gap-1.p-3", { visible: true, timeout: 30_000 });

    // 简化：按你原先逻辑迭代删除
    for (let i = 0; i < 50; i++) {
      await deleteCurrentChat(2);
      await reloadPage();
      await sleep(500);
    }
  } catch (err) {
    console.warn("批量删除失败（非致命）：", err?.message || err);
  }
}

// ---------- 导出 ----------
module.exports = {
  initBrowser,
  sendMessage,
  closeBrowser: async () => {
    try { await sleep(500); } catch {}
    try { await browser?.close(); } catch {}
  },
  ensureBrowserReady,
  deleteCurrentChat,
  reloadPage,
  deleteAllChat,
  sendTemperaryMessage,
  deleteTemporaryChat,
  // 导出错误类型以便必要时在 server.js 里细分处理（可选）
  ApiError,
};
