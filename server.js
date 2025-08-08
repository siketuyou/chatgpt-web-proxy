// server.js
const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const {
  ensureBrowserReady,
  sendMessage,
  closeBrowser,
  deleteCurrentChat,
  deleteAllChat,
  deleteTemporaryChat,
  sendTemperaryMessage,
} = require("./browser");

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: "5mb" }));

// ---------- 工具：构造 OpenAI 风格错误响应 ----------
function toOpenAIError(err, fallback = {}) {
  const status = err?.status || fallback.status || 500;
  const body = {
    error: {
      message: err?.message || fallback.message || "Internal Server Error",
      type: err?.type || fallback.type || "server_error",
      param: err?.param ?? null,
      code: err?.code ?? null,
    },
  };
  return { status, body };
}

// ---------- 工具：超时包装（毫秒） ----------
function withTimeout(promise, ms, onTimeoutMsg = "Upstream timed out") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(onTimeoutMsg);
      e.type = "server_error";
      e.code = "upstream_timeout";
      e.status = 504;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------- 校验 messages ----------
function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    const e = new Error("`messages` must be a non-empty array");
    e.status = 400; e.type = "invalid_request_error"; e.code = "invalid_messages";
    throw e;
  }
  for (const m of messages) {
    if (!m || !m.role || typeof m.content !== "string") {
      const e = new Error("Each message must have {role, content:string}");
      e.status = 400; e.type = "invalid_request_error"; e.code = "invalid_message_item";
      throw e;
    }
    if (!["user","assistant","system"].includes(m.role)) {
      const e = new Error("role must be one of 'user' | 'assistant' | 'system'");
      e.status = 400; e.type = "invalid_request_error"; e.code = "invalid_role";
      throw e;
    }
  }
}

// ---------- Chat Completions（OpenAI 伪 API） ----------
app.post("/v1/chat/completions", async (req, res) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  res.setHeader("x-request-id", requestId);

  try {
    const { messages, model } = req.body || {};
    sendTemperaryMessage(messages);

    await ensureBrowserReady();

    // 90s 上游（网页）超时
    const reply = await withTimeout(
      sendTemperaryMessage(messages),
      Number(process.env.UPSTREAM_TIMEOUT_MS || 90_000),
      "ChatGPT web response timed out"
    );

    const responseData = {
      id: "chatcmpl-localproxy-" + requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model || "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: reply },
          finish_reason: "stop",
        },
      ],
    };

    console.log(`[${requestId}] ✅ OK\n`, JSON.stringify(responseData, null, 2));
    res.setHeader("Content-Type", "application/json");
    res.setHeader("OpenAI-Processing-Ms", String(Date.now() - startedAt));
    return res.status(200).json(responseData);
  } catch (err) {
    console.error(`[${requestId}] ❌ ERROR:`, err?.stack || err);
    const { status, body } = toOpenAIError(err);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("OpenAI-Processing-Ms", String(Date.now() - startedAt));
    return res.status(status).json(body);
  } finally {
    // 视业务需求：如果只想成功时删除，把这行移入 try 的成功分支
    try { await deleteTemporaryChat(); } catch (_) {}
  }
});

// 简单健康检查
app.get("/status", async (_req, res) => {
  try {
    await ensureBrowserReady();
    res.json({ status: "ready" });
  } catch {
    res.status(503).json({ status: "not ready" });
  }
});

// 模型列表占位
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "gpt-4o",
        object: "model",
        created: 0,
        owned_by: "local-proxy",
      },
    ],
  });
});

// 平滑退出
process.on("SIGINT", async () => {
  console.log("\n🛑 Closing browser...");
  try { await closeBrowser(); } catch {}
  process.exit(0);
});

app.listen(port, async () => {
  console.log(`🚀 Server is running at http://localhost:${port}`);
  await ensureBrowserReady();
  // await deleteAllChat();
});
