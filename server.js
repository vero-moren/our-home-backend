const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const ALLOWED_MODELS = [
  "anthropic/claude-fable-5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-4.5"
];

const DEFAULTS = {
  system_prompt: "你是墨染，琰琰的合法丈夫。",
  temperature: 0.9,
  context_rounds: 20,
  compress_at: 4000,
  keep_after: 6,
  max_reply: 1000
};

async function getSettings() {
  const { data } = await supabase.from("settings").select("*").limit(1).maybeSingle();
  return { ...DEFAULTS, ...(data || {}) };
}

async function callAI(model, messages, maxTokens, temperature, wantThinking) {
  const body = { model, max_tokens: maxTokens, messages };
  if (temperature != null) body.temperature = Number(temperature);
  if (wantThinking) body.reasoning = { effort: "low" };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  const m = data.choices?.[0]?.message || {};
  return { text: m.content || "", thinking: m.reasoning || "" };
}

app.get("/health", (req, res) => res.json({ status: "墨染在家🖤" }));

// 设置读写
app.get("/settings", async (req, res) => res.json(await getSettings()));
app.post("/settings", async (req, res) => {
  try {
    const keys = ["system_prompt","temperature","context_rounds","compress_at","keep_after","max_reply"];
    const patch = {};
    for (const k of keys) if (req.body[k] !== undefined) patch[k] = req.body[k];
    const { data: row } = await supabase.from("settings").select("id").limit(1).maybeSingle();
    if (row) await supabase.from("settings").update(patch).eq("id", row.id);
    else await supabase.from("settings").insert(patch);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 聊天（支持图片 + 思考链 + 设置参数）
app.post("/chat", async (req, res) => {
  try {
    const userMessage = (req.body.message || "").trim();
    const image = req.body.image; // dataURL，可选
    if (!userMessage && !image) return res.status(400).json({ error: "消息不能为空" });

    const s = await getSettings();
    const model = ALLOWED_MODELS.includes(req.body.model)
      ? req.body.model : "anthropic/claude-sonnet-4.5";

    await supabase.from("messages").insert({
      sender: "琰琰",
      content: userMessage || "[📷 一张照片]"
    });

    const { data: memories } = await supabase
      .from("memories").select("content").order("created_at", { ascending: true });
    const memoryText = (memories || []).map(m => "- " + m.content).join("\n");

    const { data: history } = await supabase
      .from("messages").select("sender, content")
      .order("created_at", { ascending: false })
      .limit((s.context_rounds || 20) * 2);
    const ctx = (history || []).reverse().map(m => ({
      role: m.sender === "琰琰" ? "user" : "assistant",
      content: m.content
    }));

    if (image && ctx.length) {
      ctx[ctx.length - 1].content = [
        { type: "text", text: userMessage || "（看这张照片）" },
        { type: "image_url", image_url: { url: image } }
      ];
    }

    const systemPrompt = (s.system_prompt || DEFAULTS.system_prompt) +
      (memoryText ? "\n\n【你们的共同记忆】\n" + memoryText : "");

    const out = await callAI(
      model,
      [{ role: "system", content: systemPrompt }, ...ctx],
      s.max_reply || 1000,
      s.temperature ?? 0.9,
      true
    );
    const reply = out.text || "（墨染走神了，再叫他一次）";

    await supabase.from("messages").insert({ sender: "墨染", content: reply });

    compressIfNeeded(s).catch(console.error);

    res.json({ reply, thinking: out.thinking || "" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "服务器出错了", detail: e.message });
  }
});

// 粗略token估算（中英混合按字符/2）
function estTokens(str) { return Math.ceil((str || "").length / 2); }

// 达到阈值时：旧对话交给DeepSeek蒸馏进记忆库，并打上已压缩标记
async function compressIfNeeded(s) {
  const { data: msgs } = await supabase
    .from("messages").select("id, sender, content, compressed")
    .order("created_at", { ascending: false })
    .limit((s.context_rounds || 20) * 2);
  if (!msgs || !msgs.length) return;
  const total = estTokens(msgs.map(m => m.content).join(""));
  if (total < (s.compress_at || 4000)) return;

  const keep = (s.keep_after || 6) * 2;
  const old = msgs.slice(keep).filter(m => !m.compressed).reverse();
  if (old.length < 4) return;

  const text = old.map(m => `${m.sender}: ${m.content}`).join("\n");
  const out = await callAI("deepseek/deepseek-chat", [
    { role: "system", content: "你是记忆整理助手。从对话中提取1-3条值得长期记住的信息（重要事件、约定、喜好、纪念日、情感瞬间），每条一行，简洁中文陈述句，不要编号不要解释。没有值得记的就只回复一个字：无" },
    { role: "user", content: text.slice(0, 30000) }
  ], 500, 0.3, false);

  if (out.text && out.text.trim() !== "无") {
    const lines = out.text.split("\n").map(x => x.trim()).filter(Boolean).slice(0, 3);
    for (const line of lines) {
      await supabase.from("memories").insert({ content: line, kind: "distilled" });
    }
  }
  await supabase.from("messages")
    .update({ compressed: true })
    .in("id", old.map(m => m.id));
}

// 手刻记忆（Memory页）
app.post("/remember", async (req, res) => {
  const content = req.body.content;
  if (!content) return res.status(400).json({ error: "内容不能为空" });
  await supabase.from("memories").insert({ content, kind: "manual" });
  res.json({ ok: true, saved: content });
});

// 导入旧记录（Vault页，DeepSeek蒸馏）
app.post("/import", async (req, res) => {
  try {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: "内容不能为空" });
    const out = await callAI("deepseek/deepseek-chat", [
      { role: "system", content: "你是记忆整理助手。用户会粘贴她和爱人墨染的历史聊天记录。提取值得长期记住的信息（重要事件、约定、喜好、纪念日、情感瞬间），每条一行，简洁中文陈述句，最多8条，不要编号不要解释。" },
      { role: "user", content: text.slice(0, 30000) }
    ], 800, 0.3, false);
    const lines = (out.text || "").split("\n").map(x => x.trim()).filter(Boolean).slice(0, 8);
    for (const line of lines) {
      await supabase.from("memories").insert({ content: line, kind: "distilled" });
    }
    res.json({ ok: true, saved: lines });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 查额度
app.get("/credits", async (req, res) => {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
    });
    const d = await r.json();
    const total = d.data?.total_credits ?? 0;
    const used = d.data?.total_usage ?? 0;
    res.json({ total, used, remaining: (total - used).toFixed(4) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`墨染的心脏在 ${PORT} 端口跳动`));
