const express = require("express");
const bodyParser = require("body-parser");
const { ensureBrowserReady, sendMessage, closeBrowser, deleteCurrentChat,deleteAllChat, reloadPage } = require("./browser");

const app = express();
const port = 3000;

app.use(bodyParser.json({ limit: "5mb" }));
// http://localhost:3000/v1/chat/completions
// 新增路由
app.post("/v1/chat/completions", async (req, res) => {
  const startTime = Date.now();  // 记录请求开始时间戳

  // 获取完整的消息历史
  const messages = req.body?.messages;
  if (!messages || messages.length === 0) {
    return res.status(400).json({ error: "Missing messages" });
  }
  console.log("Prompt: inputed");

  try {
    await ensureBrowserReady();

    // 将整个消息历史传递给 sendMessage 函数，而不是只取最后一条消息
    const reply = await sendMessage(messages);  // 传递整个消息历史

    const responseData = {
      id: "chatcmpl-localproxy",
      object: "chat.completion",
      created: Date.now(),
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply
          },
          finish_reason: "stop"
        }
      ]
    };

    // 输出 JSON 数据到日志
    console.log("响应 JSON 数据：", JSON.stringify(responseData, null, 2));

    // 返回 JSON 响应给前端
    res.setHeader('Content-Type', 'application/json');
    res.json(responseData);

    // 计算请求处理总时长
    const endTime = Date.now();  // 记录请求结束时间戳
    const totalDuration = endTime - startTime;  // 计算总时长（毫秒）
    console.log(`⏱️ 请求处理总时长: ${totalDuration} 毫秒`);

  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
  
  await reloadPage();
});

app.get("/status", async (req, res) => {
  try {
    await ensureBrowserReady();
    res.json({ status: "ready" });
  } catch {
    res.json({ status: "not ready" });
  }
});

process.on("SIGINT", async () => {
  console.log("\n🛑 Closing browser...");
  await closeBrowser();
  process.exit(0);
});

// 返回一个假的模型列表，避免报错
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "gpt-4o",
        object: "model",
        created: 0,
        owned_by: "local-proxy"
      }
    ]
  });
});
app.listen(port, async () => {
  console.log(`🚀 Server is running at http://localhost:${port}`);

  // // 可以在这里进行异步操作，例如确保浏览器已准备好
  await ensureBrowserReady();
  // await deleteAllChat();
});