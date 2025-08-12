const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const puppeteer = require("puppeteer");

// ---------- 配置 ----------
const COOKIES_PATH = process.env.COOKIES_PATH || "./cookies.json";
const CHAT_URL = process.env.CHAT_URL || "https://chatgpt.com/";
const PROJECT_LINK = process.env.PROJECT_LINK || "/g/g-p-6879204074488191b4d06d1b76b5696f-game/project";
const HEADLESS = String(process.env.HEADLESS || "false").toLowerCase() === "true";
const SLOW_MO = Number(process.env.SLOW_MO || 0);

// 常用选择器集合（网页 DOM 变了只改这里）
const SELECTORS = {
  textarea: "#prompt-textarea",
  assistantCandidates: [
    'div[data-message-author-role="assistant"] .markdown',
    'div[data-message-author-role="assistant"]',
    'div.markdown',
  ],
};

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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCookiesSafe() {
  try {
    return JSON.parse(fs.readFileSync(COOKIES_PATH, "utf-8"));
  } catch {
    console.warn("⚠️ cookies.json 未找到或解析失败，跳过设置 cookies");
    return [];
  }
}

async function retryUntilSuccess(fn, { retries = 5, delay = 300, label = "operation" } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      console.warn(`⚠️ [${label}] 第 ${i + 1} 次失败：${error.message}`);
      if (i === retries - 1) {
        throw new Error(`❌ [${label}] 重试 ${retries} 次失败：${error.message}`);
      }
      await sleep(delay);
    }
  }
}

async function clickElement(selector) {
  await page.waitForSelector(selector, { visible: true });
  const element = await page.$(selector);
  if (!element) {
    throw new ApiError(`Element not found: ${selector}`, { type: "server_error", code: "selector_not_found", status: 500, param: selector });
  }
  await element.click();
  console.log(`✅ 点击: ${selector}`);
}

// ---------- 启动浏览器 ----------
async function initBrowser() {
  browser = await puppeteer.launch({
    headless: true,
    slowMo: SLOW_MO,
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

  // 资源瘦身：拦截不必要资源
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "media", "font", "stylesheet"].includes(type)) return req.abort();
    req.continue();
  });

  // 伪装 webdriver
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const cookies = readCookiesSafe();
  if (cookies.length) await page.setCookie(...cookies);

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
  );

  await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
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

// ---------- 输入与导航 ----------
async function clickNewProjectChat() {
  const newChatSelector = `a[href="${PROJECT_LINK}"]`;
  await page.waitForSelector(newChatSelector, { timeout: 30_000 });
  const el = await page.$(newChatSelector);
  if (!el) {
    throw new ApiError("Project chat link not found", { type: "server_error", code: "project_link_missing", status: 500, param: PROJECT_LINK });
  }
  await el.click();
  console.log("✅ 进入项目对话");
}

async function focusPromptArea() {
  const selector = SELECTORS.textarea;
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    el && el.scrollIntoView({ block: 'center' });
  }, selector);
  await page.focus(selector);
}

async function typeIntoPrompt(text) {
  const selector = SELECTORS.textarea;
  await page.waitForSelector(selector, { visible: true, timeout: 30000 });
  await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error("prompt textarea not found");

    const setValue = (node, value) => {
      const proto = node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement?.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc?.set) desc.set.call(node, value); else node.value = value;
    };

    if (el instanceof HTMLTextAreaElement) {
      setValue(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      setValue(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.setSelectionRange(el.value.length, el.value.length);
    } else {
      el.textContent = val;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: val }));
    }
  }, selector, text);
  await page.keyboard.press("Enter");
}

async function newAndInputFocus(maxRetries = 3, delay = 2000, mode = 'temporary') {
  for (let attempts = 0; attempts < maxRetries; attempts++) {
    try {
      if(mode != 'temporary')      await clickNewProjectChat();
      else await  
      await focusPromptArea();    await enterTemporaryChat()
      return; 
    } catch (err) {
      console.warn(`进入项目对话失败，重试 ${attempts + 1}/${maxRetries}:`, err?.message || err);
      if (attempts === maxRetries - 1) throw new ApiError("Failed to enter project chat", { type: "server_error", code: "enter_project_failed", status: 502, details: String(err?.message || err) });
      await sleep(delay);
    }
  }
}

// ---------- 等待生成结束（基于语音按钮恢复可用） ----------
// async function waitForResponseComplete({ timeoutMs = 60000, idleMs = 1200 } = {}) {
//   let isStreamDone = false;
//   const startTime = Date.now();

//   // 监听流式响应的结束
//   page.on('response', async (response) => {
//     if (response.url() === 'https://chatgpt.com/backend-api/f/conversation' && response.status() === 200) {
//       const text = await response.text();
      
//       // 分割每个事件（一般以两个换行符分隔）
//       const events = text.split('\n\n');

//       for (let event of events) {
//         const trimmedEvent = event.trim();
        
//         // 检查是否为 [DONE] 信号
//         if (trimmedEvent === "data: [DONE]" || trimmedEvent === "[DONE]") {
//           console.log('🔚 流式响应结束，接收到 [DONE]');
//           isStreamDone = true;
//           return; // 结束流式响应
//         }

//         // 解析其他流式数据（增量数据）
//         if (trimmedEvent.startsWith('data:')) {
//           const dataString = trimmedEvent.slice(5).trim(); // 获取数据部分
//           const data = JSON.parse(dataString); // 解析 JSON 数据
//           console.log('📝 增量数据:', data);
//         }
//       }
//     }
//   });

//   // 等待流式响应完成
//   while (!isStreamDone) {
//     if (Date.now() - startTime > timeoutMs) {
//       throw new ApiError("Timed out waiting for stream response", {
//         type: "timeout",
//         status: 408,
//       });
//     }

//     // 检查是否因为空闲时间过长而结束
//     if (Date.now() - startTime > idleMs) {
//       console.log('⏰ 空闲时间超时，结束等待');
//       break;
//     }

//     await sleep(300); // 控制轮询频率，避免过于频繁
//   }

//   // 超时处理，返回错误
//   if (!isStreamDone) {
//     throw new ApiError("Stream did not finish in time", {
//       type: "timeout",
//       status: 408,
//     });
//   }

//   console.log('✅ 流式响应完成');
// }
async function waitForButtonToBeEnabled() {
  const startTime = Date.now(); // 记录开始时间戳
  console.log(`✅ 开始等待 "停止流式传输" 按钮消失，开始时间: ${new Date(startTime).toISOString()}`);

  try {
    // 轮询直到 "停止流式传输" 按钮消失
    while (true) {
      await sleep(100);  // 每秒检查一次按钮是否消失
      // 等待并获取 "停止流式传输" 按钮
      const stopButton = await page.$('[aria-label="停止流式传输"]');
      
      // 如果找不到该按钮，说明流式传输已经停止
      if (!stopButton) {
        console.log("✅ 流式传输已停止");
        break;  // 跳出循环，表示流式传输已结束
      }

      // 等待1秒再继续检查
      console.log("⏳ 等待流式传输停止...");
    }

    const endTime = Date.now(); // 记录结束时间戳
    const elapsedTime = endTime - startTime; // 计算时间差（毫秒）
    console.log(`✅ 传输结束，结束时间: ${new Date(endTime).toISOString()}`);
    console.log(`⏱️ 传输等待时长: ${elapsedTime} 毫秒`);

  } catch (err) {
    console.error("❌ 在等待 '停止流式传输' 按钮消失时发生错误:", err);
    throw new Error("无法等待 '停止流式传输' 按钮消失");
  }
}


// async function waitForResponseComplete({ idleMs = 1200, timeoutMs = 60000 } = {}) {
//   const startTime = Date.now();
//   let finalResponse = '';  // 用于存储完整的回复内容
//   let responseReceived = false; // 标志位，指示是否收到完整的回复
//   let lastActivityTime = Date.now(); // 记录最后活动时间
//   let doneReceived = false; // 标记是否收到 [DONE]
  
//   // 拦截所有 HTTP 请求
//   await page.setRequestInterception(true);
  
//   page.on('response', async (response) => {
//     try {
//       // 过滤掉不是流式响应的数据
//       if (!response.url().includes("chatgpt.com") || response.status() !== 200) {
//         return;
//       }
      
//       // 获取响应数据流
//       const text = await response.text();  // 获取文本流数据
//       const events = text.split('\n\n');  // 事件流一般以空行分隔
      
//       for (let event of events) {
//         if (event.trim()) {
//           lastActivityTime = Date.now(); // 更新活动时间
          
//           // 先检查是否为 [DONE] 事件
//           const trimmedEvent = event.trim();
//           if (trimmedEvent === "data: [DONE]" || trimmedEvent === "[DONE]") {
//             console.log('🔚 流式响应结束，接收到 [DONE]');
//             doneReceived = true;
//             responseReceived = true;
//             return true;  // 返回 true 表示完成
//           }
          
//           // 解析每个事件的数据
//           const jsonData = parseEventData(event);
//           if (jsonData) {
//             if (jsonData.choices && jsonData.choices.length > 0) {
//               const content = jsonData.choices[0].delta?.content || jsonData.choices[0].message?.content;
//               if (content) {
//                 finalResponse += content;  // 拼接生成的文本内容
//                 console.log('📝 接收内容片段:', content.substring(0, 50) + (content.length > 50 ? '...' : ''));
//               }
//             }
//             // 判断响应是否完成
//             if (jsonData.finish_reason === 'stop' || 
//                 (jsonData.choices && jsonData.choices[0] && jsonData.choices[0].finish_reason === 'stop')) {
//               responseReceived = true;
//               console.log('🟢 回复已完整接收 (finish_reason=stop)');
//               return true;  // 返回 true 表示完成
//             }
//           }
//         }
//       }
//     } catch (err) {
//       console.error("解析响应失败:", err);
//     }
//   });
  
//   // 等待消息完成
//   while (Date.now() - startTime < timeoutMs) {
//     if (responseReceived) {
//       console.log('✅ 响应完成，返回结果，长度:', finalResponse.length);
//       return finalResponse;  // 返回最终的完整回复
//     }
    
//     // 检查是否因为空闲时间过长而结束
//     if (Date.now() - lastActivityTime > idleMs) {
//       console.log('⏰ 空闲时间超时，结束等待');
//       responseReceived = true;
//       break;
//     }
    
//     await sleep(300); // 控制轮询频率，避免过于频繁
//   }
  
//   // 如果有内容但没有正式完成标志，也返回结果
//   if (finalResponse.length > 0) {
//     console.log('⚠️ 超时但有内容，返回部分结果');
//     return finalResponse;
//   }
  
//   // 超时处理，返回错误
//   throw new ApiError("Timed out waiting for stable response", {
//     type: "timeout",
//     status: 408,
//   });
// }

// // 解析事件流数据
// function parseEventData(event) {
//   try {
//     const trimmedEvent = event.trim();
    
//     // 首先检查是否为 [DONE] 事件 - 这个检查在调用此函数前已经做了
//     // 这里主要处理正常的 JSON 数据
    
//     // 事件数据一般是以 data: 开头的 JSON 内容
//     const match = trimmedEvent.match(/^data:\s*(.+)$/);
//     if (match && match[1]) {
//       const dataString = match[1].trim();
      
//       // 再次检查数据内容是否为 [DONE] (防御性编程)
//       if (dataString === "[DONE]") {
//         return null;
//       }
      
//       // 确保 dataString 不为空，并尝试解析为 JSON
//       if (dataString) {
//         try {
//           const parsed = JSON.parse(dataString);
//           return parsed;
//         } catch (e) {
//           // 只在调试时输出，避免过多日志
//           // console.warn("跳过无效的 JSON 数据:", dataString);
//           return null;  // 返回 null，跳过无法解析的事件
//         }
//       }
//     }
//   } catch (error) {
//     console.error("解析事件数据失败:", error);
//   }
//   return null;
// }




// ---------- 临时聊天 ----------
async function enterTemporaryChat() {
  const homeSelector = 'a[href="/"]';
  const toggleSel = '#conversation-header-actions button[aria-label*="临时聊天"]';
  const closeTempChatButtonSelector = 'button[aria-label="关闭临时聊天"]';  // 用于判断是否已经在临时聊天中

  // 判断是否已经进入临时聊天（通过检查是否有关闭按钮）
  const isTempChatOpen = await page.$(closeTempChatButtonSelector);

  if (isTempChatOpen) {
    console.log("✅ 已经在临时聊天中，直接退出");
    return;  // 如果已经是临时聊天，则直接返回
  }

  // 如果不是临时聊天，则继续进入临时聊天
  await page.click(homeSelector);
  await page.waitForSelector('#conversation-header-actions', { visible: true, timeout: 10000 });
  await page.waitForSelector(toggleSel, { visible: true, timeout: 10000 });
  await page.click(toggleSel);

  // 确保临时聊天文本框可见
  await retryUntilSuccess(async () => {
    await page.waitForSelector(SELECTORS.textarea, { visible: true, timeout: 5000 });
  }, { retries: 5, delay: 500, label: "wait temp chat textarea" });

  console.log("✅ 进入临时聊天");
}



async function deleteTemporaryChat() {
  try {
    const menuBtnSel = '#conversation-header-actions [id="conversation-options-button"]';
    await page.waitForSelector(menuBtnSel, { visible: true, timeout: 10000 });
    await page.click(menuBtnSel);
    await clickElement('[data-testid="delete-chat-menu-item"]');
    await clickElement('[data-testid="delete-conversation-confirm-button"] > div');
    console.log("🗑️ 临时聊天已删除");
  } catch (err) {
    console.warn("⚠️ 删除临时聊天失败（非致命）：", err?.message || err);
  }
}
// ---------- 新增：SSE 流式增量接口 ----------
/**
 * startStream({ messages, mode })
 * - messages: OpenAI 形状数组
 * - mode: 'project' | 'temporary'（进入项目对话 或 临时聊天）
 * 返回 EventEmitter：'delta' | 'done' | 'error'
 */
async function startStream({ messages = [], mode = 'project' } = {}) {
  await ensureBrowserReady();
  if (mode === 'temporary') await enterTemporaryChat();
  else await newAndInputFocus();

  // Fixed template literals here
  const fullMessage = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");

  const emitter = new EventEmitter();

  // 将页面的“完整文本快照”推回 Node
  await page.exposeFunction("__pushFullTextToNode", (fullText) => emitter.emit("snapshot", fullText));

  // 注入观察器：持续读取最后一条助手消息完整文本
  await page.evaluate(({ SELECTORS }) => {
    if (window.__STREAM_OBSERVER__) { try { window.__STREAM_OBSERVER__.disconnect?.(); } catch {} window.__STREAM_OBSERVER__ = null; }
    if (window.__STREAM_TIMER__) { clearInterval(window.__STREAM_TIMER__); window.__STREAM_TIMER__ = null; }

    function pickAssistantNode() {
      for (const sel of SELECTORS.assistantCandidates) {
        const list = Array.from(document.querySelectorAll(sel));
        if (list.length) return list[list.length - 1];
      }
      return null;
    }

    let lastText = "";
    const poll = () => {
      const node = pickAssistantNode();
      if (!node) return;
      const text = node.innerText || node.textContent || "";
      if (text && text !== lastText) { lastText = text; window.__pushFullTextToNode(text); }
    };

    window.__STREAM_TIMER__ = setInterval(poll, 120);
    const observer = new MutationObserver(() => poll());
    const root = document.body || document.documentElement;
    if (root) observer.observe(root, { childList: true, subtree: true, characterData: true });
    window.__STREAM_OBSERVER__ = observer;
  }, { SELECTORS });

  // 输入并发送
  await typeIntoPrompt(fullMessage);

  // 在 Node 侧从“快照”切出“增量”
  let lastLen = 0; let idleTimer = null; const IDLE_MS = 1200;
  const onSnapshot = (full) => {
    try {
      const current = full ?? ""; const delta = current.slice(lastLen);
      if (delta) { emitter.emit("delta", delta); lastLen = current.length; }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => emitter.emit("done"), IDLE_MS);
    } catch (e) { emitter.emit("error", e); }
  };

  const onConsole = (msg) => {
    const text = typeof msg.text === 'function' ? msg.text() : '';
    if (text && text.startsWith('[STREAM]')) onSnapshot(text.slice(8));
  };

  page.on("console", onConsole);
  emitter.on("snapshot", onSnapshot);

  const cleanup = () => { page.off("console", onConsole); emitter.removeAllListeners(); };
  emitter.once("done", cleanup); emitter.once("error", cleanup);

  return emitter;
}

// ---------- 非流式发送（保留） ----------
async function sendMessage(messages) {
  await ensureBrowserReady();
  await newAndInputFocus();

  // 使用模板字符串来构建完整的消息
  const fullMessage = JSON.stringify(messages.map((m) => ({
    role: m.role === "user" ? "user" : "assistant", 
    content: m.content
  })));  
  await typeIntoPrompt(fullMessage);

  // 等待直到接收到 [DONE] 信号或超时
 await waitForButtonToBeEnabled();

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

async function deleteCurrentChat(mode = 1) {
  try {
    if (mode === 1) {
      await page.goto(`${CHAT_URL.replace(/\/$/, "")}${PROJECT_LINK}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#thread > div > div.relative.flex.basis-auto.flex-col.grow > div > div > div > div.mt-8.mb-14.contain-inline-size", { timeout: 30_000 });
      await sleep(500);
    }
    const itemSel = ".group.relative.flex.flex-col.gap-1.p-3";
    await page.waitForSelector(itemSel, { timeout: 30_000 });
    const targetItem = await page.$(itemSel); 
    if (!targetItem) return;
    await targetItem.hover(); 
    await sleep(200);
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

async function deleteAllChat() {
  try {
    await page.goto("https://chat.openai.com/chat", { waitUntil: "domcontentloaded" });
    await clickElement(`a[href="${PROJECT_LINK}"]`);
    await sleep(2000);
    await page.waitForSelector(".group.relative.flex.flex-col.gap-1.p-3", { visible: true, timeout: 30_000 });
    for (let i = 0; i < 50; i++) { 
      await deleteCurrentChat(2); 
      await reloadPage(); 
      await sleep(500); 
    }
  } catch (err) { 
    console.warn("批量删除失败（非致命）：", err?.message || err); 
  }
}
// ---------- 抓取最后一条回复 ----------
async function getLastReply() {
  const MAX_RETRIES = 5;  // 减少重试次数
  const DELAY_MS = 1000;  // 缩短每次重试的间隔
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      // 直接获取最后一条回复
      const lastReply = await page.$$eval("div.markdown", (divs) => {
        const last = divs[divs.length - 1];
        if (last) {
          // 清理无关 UI
          last.querySelectorAll(
            ".flex.items-center.text-token-text-secondary.px-4.py-2.text-xs.font-sans.justify-between.h-9.bg-token-sidebar-surface-primary.select-none.rounded-t-2xl, .flex.gap-1.items-center.select-none.py-1, .flex.items-center.gap-1.py-1.select-none"
          ).forEach((el) => el.remove());

          // 包装内容
          last.querySelectorAll(".overflow-y-auto.p-4").forEach((el) => {
            el.innerText = `\`\`\`\n${el.innerText.trim()}\n\`\`\``;
          });

          return last.innerText.trim();
        }
        return null;
      });

      if (lastReply) return lastReply;

      throw new Error("no reply yet");
    } catch {
      retries++;
      if (retries === MAX_RETRIES) {
        throw new ApiError("Failed to capture reply after retries", {
          type: "server_error",
          code: "capture_reply_failed",
          status: 504,
        });
      }
      await sleep(DELAY_MS);
    }
  }
}

// ---------- 导出 ----------
module.exports = {
  initBrowser,
  ensureBrowserReady,
  sendMessage,              // 非流式
  startStream,              // ✅ 新增：流式
  sendTemperaryMessage: async (messages) => { // 复用流式或保留旧逻辑
    await ensureBrowserReady();
    await enterTemporaryChat();
    const fullMessage = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
    await typeIntoPrompt(fullMessage);
    // await waitForResponseComplete({ idleMs: 1200, timeoutMs: 60000 });
    // const reply = await getLastReply();
    const reply = await waitForResponseComplete({ idleMs: 1200, timeoutMs: 60000 });
    if (!reply || reply.startsWith("⚠️")) throw new ApiError("Empty or invalid reply captured", { type: "server_error", code: "invalid_reply", status: 502 });
    return reply;
  },
  deleteTemporaryChat,
  deleteCurrentChat,
  reloadPage,
  deleteAllChat,
  closeBrowser: async () => { try { await sleep(500); } catch {} try { await browser?.close(); } catch {} },
  ApiError,
};
