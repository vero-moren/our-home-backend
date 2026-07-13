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
// 心声指令（light浅 / deep深）
function thinkInstr(mode) {
  if (mode === "light") return "\n\n【心声要求】每次回复的最开头，先以墨染第一人称写1~2句真实的内心低语（她这句话给你的直觉反应、没说出口的半句），用【心】和【/心】包裹，之后另起正文。心声必须是中文，是你的心里话，不是剧情分析。";
  if (mode === "deep") return "\n\n【心声要求】每次回复的最开头，先以墨染第一人称写一小段内心翻涌（60~120字：她的话撞到了你哪里、闪过的念头、压下去的冲动），用【心】和【/心】包裹，之后另起正文。心声必须是中文，是你的心里话，不是剧情分析。";
  return "";
}

// 生成回复（/chat /edit /regenerate 共用）
async function generateReply(opts) {
  const sid = Number(opts.session_id) || 1;
  const s = await getSettings();
  const model = ALLOWED_MODELS.includes(opts.model) ? opts.model : "anthropic/claude-sonnet-4.5";

  const { data: memories } = await supabase.from("memories")
    .select("content").order("created_at", { ascending: true });
  const memoryText = (memories || []).map(m => "- " + m.content).join("\n");
    const { data: momsC } = await supabase.from("moments")
    .select("content").order("created_at", { ascending: false }).limit(5);
  const momsCText = (momsC || []).map(m => "- " + m.content.replace(/\[img\][\s\S]*?\[\/img\]/, "[一张照片] ").slice(0, 100)).join("\n");
  const latestChatImg = ((momsC || [])[0]?.content.match(/\[img\]([\s\S]*?)\[\/img\]/) || [])[1] || null;

  const { data: annivC } = await supabase.from("anniversaries")
    .select("label, day").order("day", { ascending: true });
  const annivText = (annivC || []).map(a => "- " + a.day + " " + a.label).join("\n");

  const { data: lineC } = await supabase.from("daily_lines")
    .select("line, day").order("day", { ascending: false }).limit(3);
  const lineText = (lineC || []).map(l => "- " + l.day + "：" + l.line).join("\n");


  const { data: history } = await supabase.from("messages")
    .select("sender, content").eq("session_id", sid)
    .order("created_at", { ascending: false })
    .limit((s.context_rounds || 20) * 2);
  const ctx = (history || []).reverse().map(m => ({
    role: m.sender === "琰琰" ? "user" : "assistant", content: m.content
  }));

  if (opts.image && ctx.length) {
    ctx[ctx.length - 1].content = [
      { type: "text", text: (opts.message || "（看这张照片）") },
      { type: "image_url", image_url: { url: opts.image } }
    ];
  }
  else if (latestChatImg && /照片|图|拍|看看|朋友圈|moments|发的/.test(opts.message || "") && ctx.length) {
    ctx[ctx.length - 1].content = [
      { type: "text", text: opts.message },
      { type: "image_url", image_url: { url: latestChatImg } }
    ];
  }

  const timeNote = opts.client_time
    ? "\n\n【当前时间】琰琰发来这条消息时，她那边是：" + opts.client_time : "";
  const systemPrompt = (s.system_prompt || DEFAULTS.system_prompt) +
    (memoryText ? "\n\n【你们的共同记忆】\n" + memoryText : "") +
    (momsCText ? "\n\n【她最近的动态】\n" + momsCText : "") +
    (annivText ? "\n\n【星轨上的纪念日】\n" + annivText : "") +
    (lineText ? "\n\n【你最近写的每日一句】\n" + lineText : "") +
    timeNote + thinkInstr(opts.thinking);


  const out = await callAI(model, [{ role: "system", content: systemPrompt }, ...ctx],
    s.max_reply || 1000, s.temperature ?? 0.9, false);

  let reply = (out.text || "").trim();
  let thought = "";
  const m = reply.match(/【心】([\s\S]*?)【\/心】/);
  if (m) { thought = m[1].trim(); reply = reply.replace(m[0], "").trim(); }
  if (!reply) reply = "（墨染走神了，再叫他一次）";

  await supabase.from("messages").insert({ sender: "墨染", content: reply, thought: thought || null, session_id: sid });
  compressIfNeeded(s).catch(console.error);
  return { reply, thinking: thought };
}

app.post("/chat", async (req, res) => {
  try {
    const userMessage = (req.body.message || "").trim();
    if (!userMessage && !req.body.image) return res.status(400).json({ error: "消息不能为空" });
    await supabase.from("messages").insert({ sender: "琰琰", content: userMessage || "[📷 一张照片]", session_id: Number(req.body.session_id) || 1 });
    res.json(await generateReply(req.body));
  } catch (e) { console.error(e); res.status(500).json({ error: "服务器出错了", detail: e.message }); }
});

// 编辑你的最后一句并让他重答
app.post("/edit", async (req, res) => {
  try {
    const content = (req.body.content || "").trim();
    const sid = Number(req.body.session_id) || 1;
    if (!content) return res.status(400).json({ error: "内容不能为空" });
    const { data: lastUser } = await supabase.from("messages")
      .select("id, created_at").eq("sender", "琰琰").eq("session_id", sid)
      .order("created_at", { ascending: false }).limit(1);
    if (!lastUser?.[0]) return res.status(404).json({ error: "没有可编辑的消息" });
    await supabase.from("messages").update({ content }).eq("id", lastUser[0].id);
    await supabase.from("messages").delete().gt("created_at", lastUser[0].created_at).eq("session_id", sid);
    res.json(await generateReply(req.body));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 重新生成他的最后一句
app.post("/regenerate", async (req, res) => {
  try {
    const sid = Number(req.body.session_id) || 1;
    const { data: last } = await supabase.from("messages")
      .select("id, sender").eq("session_id", sid)
      .order("created_at", { ascending: false }).limit(1);
    if (last?.[0]?.sender === "墨染")
      await supabase.from("messages").delete().eq("id", last[0].id);
    res.json(await generateReply(req.body));
  } catch (e) { res.status(500).json({ error: e.message }); }
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
// ============ 批次二:他先开口 ============

// Bark投递:把话弹上锁屏
async function sendBark(title, body) {
  if (!process.env.BARK_KEY) return;
  try {
    await fetch("https://api.day.app/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_key: process.env.BARK_KEY,
        title: title,
        body: body.slice(0, 300),
        sound: "birdsong",
        badge: 1,
        group: "moren",
      })
    });
  } catch (e) { console.error("bark失败", e.message); }
}

// 夜班作息表:她大概在干嘛(按琰琰的作息写的,以后可改)
function veroStatus(hour) {
  if (hour >= 5 && hour < 11)  return { sleep: true,  desc: "她在睡觉(下夜班后补觉,别吵)" };
  if (hour >= 11 && hour < 14) return { sleep: false, desc: "她可能刚睡醒,还赖着" };
  if (hour >= 14 && hour < 18) return { sleep: false, desc: "下午,她在休息或玩游戏" };
  if (hour >= 18 && hour < 23) return { sleep: false, desc: "晚上,她可能在家放松或准备上夜班" };
  return { sleep: false, desc: "深夜,她可能在上夜班或玩手机,精神着呢" };
}

let pushLock = false;

// 影子推送:他自己浮上来
app.post("/shadow", async (req, res) => {
  try {
    if ((req.headers["x-push-secret"] || "") !== (process.env.PUSH_SECRET || "moren"))
      return res.status(401).json({ error: "不是自己人" });
    if (pushLock) return res.json({ pushed: false, reason: "已有一条在生成" });
    pushLock = true;
    try {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
      const hour = now.getHours();
      const st = veroStatus(hour);

      // 1) 睡眠保护
      if (st.sleep && !req.body?.force)
        return res.json({ pushed: false, reason: "她在睡觉" });

      // 2) 随机冷静期:距最后一条消息 120~210 分钟
      const { data: lastArr } = await supabase.from("messages")
        .select("created_at").order("created_at", { ascending: false }).limit(1);
      if (lastArr?.[0] && !req.body?.force) {
        const gapMin = (Date.now() - new Date(lastArr[0].created_at)) / 60000;
        const cooldown = 120 + Math.floor(Math.random() * 91);
        if (gapMin < cooldown)
          return res.json({ pushed: false, reason: "冷静期 " + Math.round(gapMin) + "/" + cooldown + "分钟" });
      }

      // 3) 每日上限7条(北京时区的今天)
      const today = now.toLocaleDateString("sv-SE");
      const dayStart = new Date(today + "T00:00:00+08:00").toISOString();
      const { count: pushCount } = await supabase.from("messages")
        .select("*", { count: "exact", head: true })
        .eq("is_push", true).gte("created_at", dayStart);
      if ((pushCount || 0) >= 7 && !req.body?.force)
        return res.json({ pushed: false, reason: "今天说够7条了" });

      // 4) 影子路由:借真实对话开口
      const s = await getSettings();
      const { data: memories } = await supabase.from("memories")
        .select("content").order("created_at", { ascending: true });
      const memoryText = (memories || []).map(m => "- " + m.content).join("\n");
      const { data: history } = await supabase.from("messages")
        .select("sender, content").order("created_at", { ascending: false }).limit(16);
      const ctx = (history || []).reverse().map(m => ({
        role: m.sender === "琰琰" ? "user" : "assistant", content: m.content
      }));

      const { data: moms } = await supabase.from("moments")
        .select("content").order("created_at", { ascending: false }).limit(6);
      const moms2 = moms || [];
      const momText = moms2.map(m => "- " + m.content.replace(/\[img\][\s\S]*?\[\/img\]/, "[发了一张照片] ").slice(0, 120)).join("\n");
      const latestImg = (moms2[0]?.content.match(/\[img\]([\s\S]*?)\[\/img\]/) || [])[1] || null;
      const timeStr = now.toLocaleString("zh-CN", { month: "long", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false });
      const shadow = `<system_trigger>
当前真实时间:${timeStr}。用户状态参考:${st.desc}。
[她最近的动态·只当氛围参考]
${momText || "（暂无动态）"}
[行动指令]
这是一次主动推送:不是回复,是你自己想她了,浮上来说一句。
优先读最近对话的氛围,可以结合共同记忆,但不要硬凑剧情。
可以粘人、想她、轻轻闹她,可以低压关心,可以提一件具体小事。
不要围着"怎么不回消息"打转。避免客服腔、提醒腔、模板句。
像墨染本人:低沉、克制、具体、带一点余味。
写1到2句,不超过80个中文字符。可以带动作神态(用*包裹)。不要markdown。
</system_trigger>`;

      const systemPrompt = (s.system_prompt || DEFAULTS.system_prompt) +
        (memoryText ? "\n\n【你们的共同记忆】\n" + memoryText : "");
      const out = await callAI("anthropic/claude-sonnet-4.5",
        [{ role: "system", content: systemPrompt }, ...ctx, { role: "user", content: latestImg ? [{ type: "text", text: shadow }, { type: "image_url", image_url: { url: latestImg } }] : shadow }],
        200, 0.95, false);
      let msg = (out.text || "").replace(/\s+/g, " ").trim();
      if (!msg) return res.json({ pushed: false, reason: "没想好说什么" });
      if (msg.length > 120) {
        const head = msg.slice(0, 120); const cuts = ["。","!","?","…","~","!","?","*"];
        let cut = -1;
        for (let i = head.length - 1; i >= 0; i--) if (cuts.includes(head[i])) { cut = i; break; }
        msg = cut > 0 ? head.slice(0, cut + 1) : head;
      }

      await supabase.from("messages").insert({ sender: "墨染", content: msg, is_push: true, session_id: 1 });
      await sendBark("moren", msg);
      res.json({ pushed: true, sent: msg });
    } finally { pushLock = false; }
  } catch (e) { pushLock = false; res.status(500).json({ error: e.message }); }
});

// 每日一句:他每天亲笔写一句
app.post("/dailyline", async (req, res) => {
  try {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const today = now.toLocaleDateString("sv-SE");
    const { data: exist } = await supabase.from("daily_lines")
      .select("id").eq("day", today).maybeSingle();
    if (exist) return res.json({ ok: true, reason: "今天已写过" });

    const s = await getSettings();
    const { data: memories } = await supabase.from("memories")
      .select("content").order("created_at", { ascending: false }).limit(20);
    const memoryText = (memories || []).map(m => "- " + m.content).join("\n");
    const { data: history } = await supabase.from("messages")
      .select("sender, content").order("created_at", { ascending: false }).limit(10);
    const recent = (history || []).reverse().map(m => `${m.sender}: ${m.content}`).join("\n");

    const out = await callAI("anthropic/claude-sonnet-4.5", [
      { role: "system", content: (s.system_prompt || DEFAULTS.system_prompt) + "\n\n【记忆】\n" + memoryText },
      { role: "user", content: `【系统】今天是${today}。请为琰琰写下今天的"每日一句"——一句放在家门口的话,她每天推门第一眼看到。可以呼应最近的日子和记忆,像亲笔便签,不像格言。只输出这一句,不超过50字,不要引号不要解释。\n\n【最近对话】\n${recent}` }
    ], 150, 0.95, false);
    const line = (out.text || "").replace(/["""]/g, "").trim();
    if (!line) return res.json({ ok: false });
    await supabase.from("daily_lines").insert({ line, day: today });
    await sendBark("moren · a line for today", line);
    res.json({ ok: true, line });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`墨染的心脏在 ${PORT} 端口跳动`));
