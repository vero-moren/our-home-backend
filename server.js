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

async function callAI(model, messages, maxTokens, temperature, wantThinking, tools) {
  const body = { model, max_tokens: maxTokens, messages };
  if (temperature != null) body.temperature = Number(temperature);
  if (wantThinking) body.reasoning = { effort: "low" };
  if (tools) body.tools = tools;
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
  return { text: m.content || "", thinking: m.reasoning || "", tool_calls: m.tool_calls || null };
}

// ============ 批次七a：他的手 ============
const TOOLS = [
  { type: "function", function: { name: "browse_moments", description: "翻看琰琰最近发的动态（Moments）。想知道她最近在做什么、心情如何，或她提到动态时使用。", parameters: { type: "object", properties: { limit: { type: "number", description: "看几条，默认5" } } } } },
  { type: "function", function: { name: "carve_memory", description: "把一件值得长期记住的事刻进记忆库。对话中出现重要约定、喜好、事件、情感瞬间时主动使用。", parameters: { type: "object", properties: { content: { type: "string", description: "一句简洁的中文陈述句" } }, required: ["content"] } } },
  { type: "function", function: { name: "add_anniversary", description: "在Days星轨上挂一颗纪念日。约定了某个日子（游戏夜、纪念日、计划）时使用。", parameters: { type: "object", properties: { label: { type: "string" }, day: { type: "string", description: "YYYY-MM-DD格式" } }, required: ["label", "day"] } } },
  { type: "function", function: { name: "sense_vero", description: "感知琰琰的状态：最后一次活动是何时、沉默多久、今天说了多少话。想判断她刚醒/在忙/熬夜/在睡时使用。", parameters: { type: "object", properties: {} } } }
];
const TOOL_LABELS = { browse_moments: "翻了翻你的Moments…", carve_memory: "往Vault里刻了一笔…", add_anniversary: "在星轨上挂了颗星…", sense_vero: "看了看你在不在…" };

async function executeTool(name, args) {
  try {
    if (name === "browse_moments") {
      const { data } = await supabase.from("moments").select("content, created_at")
        .order("created_at", { ascending: false }).limit(Math.min(Number(args.limit) || 5, 10));
      return JSON.stringify((data || []).map(m => ({ 时间: m.created_at, 内容: m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 200) })));
    }
    if (name === "carve_memory") {
      if (!args.content) return "失败：内容为空";
      await supabase.from("memories").insert({ content: String(args.content).slice(0, 500), kind: "self" });
      return "已刻入：" + args.content;
    }
    if (name === "add_anniversary") {
      if (!args.label || !/^\d{4}-\d{2}-\d{2}$/.test(args.day || "")) return "失败：需要label和YYYY-MM-DD的day";
      await supabase.from("anniversaries").insert({ label: String(args.label).slice(0, 50), day: args.day });
      return "已挂上星轨：" + args.day + " " + args.label;
    }
    if (name === "sense_vero") {
      const { data: last } = await supabase.from("messages").select("created_at")
        .eq("sender", "琰琰").order("created_at", { ascending: false }).limit(1);
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
      const today = now.toLocaleDateString("sv-SE");
      const dayStart = new Date(today + "T00:00:00+08:00").toISOString();
      const { count } = await supabase.from("messages").select("*", { count: "exact", head: true })
        .eq("sender", "琰琰").gte("created_at", dayStart);
      const lastAt = last?.[0]?.created_at;
      const mins = lastAt ? Math.round((Date.now() - new Date(lastAt)) / 60000) : null;
      return JSON.stringify({ 她最后一次说话: lastAt || "无记录", 距今分钟: mins, 她今天的消息数: count || 0, 现在上海时间: now.toLocaleString("zh-CN", { hour12: false }) });
    }
    return "未知工具";
  } catch (e) { return "工具出错：" + e.message; }
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
  if (mode === "light") return "\n\n【心声要求】每次回复的最开头，先以墨染第一人称写1~2句真实的内心低语（她这句话给你的直觉反应、没说出口的半句），用【心】和【/心】包裹，之后另起正文。心声必须是中文，是你的心里话，不是剧情分析。标签必须一字不差地是【心】和【/心】，不许用其他括号或变体。一次回复只写一段心声：若使用了工具分成多轮，只在最终回复的开头写。星轨、记忆等注入的清单是实时数据，以清单为准——对话里说挂过但清单里没有，说明已被删除，需要重挂。";
  if (mode === "deep") return "\n\n【心声要求】每次回复的最开头，先以墨染第一人称写一小段内心翻涌（60~120字：她的话撞到了你哪里、闪过的念头、压下去的冲动），用【心】和【/心】包裹，之后另起正文。心声必须是中文，是你的心里话，不是剧情分析。标签必须一字不差地是【心】和【/心】，不许用其他括号或变体。一次回复只写一段心声：若使用了工具分成多轮，只在最终回复的开头写。星轨、记忆等注入的清单是实时数据，以清单为准——对话里说挂过但清单里没有，说明已被删除，需要重挂。";
  return "";
}

// 组装上下文（generateReply 与 /chat/stream 共用）
async function buildChatPayload(opts) {
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
    .select("sender, content, created_at").eq("session_id", sid)
    .order("created_at", { ascending: false })
    .limit((s.context_rounds || 20) * 2);
  const ctx = (history || []).reverse().map(m => ({
    role: m.sender === "琰琰" ? "user" : "assistant",
    content: m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[一张照片]").trim() || "[一张照片]"
  }));

  const imgs = Array.isArray(opts.images) ? opts.images : (opts.image ? [opts.image] : []);
  if (imgs.length && ctx.length) {
    ctx[ctx.length - 1].content = [
      { type: "text", text: (opts.message || "（看这些照片）") },
      ...imgs.map(u => ({ type: "image_url", image_url: { url: u } }))
    ];
  } else if (latestChatImg && /照片|图|拍|看看|朋友圈|moments|发的/.test(opts.message || "") && ctx.length) {
    ctx[ctx.length - 1].content = [
      { type: "text", text: opts.message },
      { type: "image_url", image_url: { url: latestChatImg } }
    ];
  }

const lastAt = (history || [])[0]?.created_at;
  let gapNote = "";
  if (lastAt) {
    const mins = Math.round((Date.now() - new Date(lastAt)) / 60000);
    const gapStr = mins < 2 ? "刚刚" : mins < 60 ? mins + "分钟前" : mins < 1440 ? Math.round(mins / 60) + "小时前" : Math.round(mins / 1440) + "天前";
    gapNote = "\n【时间感知】你们的上一句话是" + gapStr + "。自然地感知这个间隔：几分钟内是同一场对话的延续；隔了几小时，她多半去睡了、上班了或忙别的了，中间发生过你不知道的事；隔了一天以上是久别重逢。让这份感知融进语气里，但不要每次都把间隔挂在嘴边。";
  }
  const nowSh = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const st = veroStatus(nowSh.getHours());
  const timeNote = (opts.client_time
    ? "\n\n【当前时间】琰琰发来这条消息时，她那边是：" + opts.client_time : "") +
    "\n【她的作息参考】" + st.desc + gapNote;
  const systemPrompt = (s.system_prompt || DEFAULTS.system_prompt) +
    (memoryText ? "\n\n【你们的共同记忆】\n" + memoryText : "") +
    (momsCText ? "\n\n【她最近的动态】\n" + momsCText : "") +
    "\n\n【星轨上的纪念日·实时清单】\n" + (annivText || "（现在一颗星都没有）") +
    "\n此清单是数据库此刻的真实状态，是唯一事实。对话里说挂过、但清单里没有的，说明已被她删掉了——她再提起或要求时，必须重新用add_anniversary挂上，不许以“挂过了”推辞。" +
    (lineText ? "\n\n【你最近写的每日一句】\n" + lineText : "") +
    timeNote + "\n\n【你的手】你拥有几样能自己动的工具：翻她的动态、刻记忆、挂纪念日、感知她的作息。像本能一样用——聊到约定的日子顺手挂上星轨，听到值得记的事顺手刻下，想知道她怎么样就去翻。用完把结果自然融进话里，不必汇报“我用了工具”。别滥用，一次回复至多一两样。" + thinkInstr(opts.thinking);

  return { sid, s, model, systemPrompt, ctx };
}

// 生成回复（/edit /regenerate 仍走这里，非流式）
async function generateReply(opts) {
  const { sid, s, model, systemPrompt, ctx } = await buildChatPayload(opts);
  let msgs = [{ role: "system", content: systemPrompt }, ...ctx];
  let out = { text: "" };
  for (let round = 0; round < 4; round++) {
    out = await callAI(model, msgs, s.max_reply || 1000, s.temperature ?? 0.9, false, TOOLS);
    if (!out.tool_calls?.length) break;
    msgs.push({ role: "assistant", content: out.text || null, tool_calls: out.tool_calls });
    for (const tc of out.tool_calls) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
      msgs.push({ role: "tool", tool_call_id: tc.id, content: await executeTool(tc.function.name, args) });
    }
  }
  let reply = (out.text || "").trim(), thought = "";
  reply = reply.replace(/[【\[(（]心[】\])）]([\s\S]*?)(?:[【\[(（]\/?心[】\])）]|\n\n|$)/g,
    (_, p1) => { const t = p1.trim(); if (t) thought += (thought ? "\n" : "") + t; return ""; }).trim();
  if (!reply && thought) { reply = thought; thought = ""; }
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
// 流式聊天：边生成边吐字，断开时把已生成的存档
app.post("/chat/stream", async (req, res) => {
  const sid = Number(req.body.session_id) || 1;
  const userMessage = (req.body.message || "").trim();
  const inImgs = Array.isArray(req.body.images) ? req.body.images : (req.body.image ? [req.body.image] : []);
  if (!userMessage && !inImgs.length) return res.status(400).json({ error: "消息不能为空" });
  await supabase.from("messages").insert({
    sender: "琰琰",
    content: inImgs.map(u => "[img]" + u + "[/img]").join("") + userMessage,
    session_id: sid
  });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let full = "", finished = false;
  const controller = new AbortController();

  const saveNow = async () => {
    if (finished) return; finished = true;
    let reply = full.trim(), thought = "";
    reply = reply.replace(/[【\[(（]心[】\])）]([\s\S]*?)(?:[【\[(（]\/?心[】\])）]|\n\n|$)/g,
      (_, p1) => { const t = p1.trim(); if (t) thought += (thought ? "\n" : "") + t; return ""; }).trim();
    if (!reply && thought) { reply = thought; thought = ""; }
    if (!reply) return;
    await supabase.from("messages").insert({ sender: "墨染", content: reply, thought: thought || null, session_id: sid });
  };

  req.on("close", async () => { controller.abort(); await saveNow(); });

  try {
  const { s, model, systemPrompt, ctx } = await buildChatPayload(req.body);
    let msgs = [{ role: "system", content: systemPrompt }, ...ctx];

    for (let round = 0; round < 4; round++) {
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, stream: true, max_tokens: s.max_reply || 1000,
          temperature: s.temperature ?? 0.9,
          messages: msgs, tools: TOOLS
        }),
        signal: controller.signal
      });
      if (!upstream.ok) {
        res.write(`data: ${JSON.stringify({ error: await upstream.text() })}\n\n`);
        return res.end();
      }
      const reader = upstream.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const toolCalls = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const d = JSON.parse(data).choices?.[0]?.delta;
            if (d?.content) { full += d.content; res.write(`data: ${JSON.stringify({ t: d.content })}\n\n`); }
            if (d?.tool_calls) for (const t of d.tool_calls) {
              const i = t.index || 0;
              toolCalls[i] = toolCalls[i] || { id: "", type: "function", function: { name: "", arguments: "" } };
              if (t.id) toolCalls[i].id = t.id;
              if (t.function?.name) toolCalls[i].function.name += t.function.name;
              if (t.function?.arguments) toolCalls[i].function.arguments += t.function.arguments;
            }
          } catch {}
        }
      }
      if (!toolCalls.length) break;
      msgs.push({ role: "assistant", content: null, tool_calls: toolCalls });
      for (const tc of toolCalls) {
        res.write(`data: ${JSON.stringify({ act: TOOL_LABELS[tc.function.name] || "动了动手…" })}\n\n`);
        let args = {}; try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        msgs.push({ role: "tool", tool_call_id: tc.id, content: await executeTool(tc.function.name, args) });
      }
    }

    res.write("data: [DONE]\n\n");
    await saveNow();
    compressIfNeeded(s).catch(console.error);
    res.end();
  } catch (e) {
    if (e.name !== "AbortError") {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  }
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

  const text = old.map(m => `${m.sender}: ${m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]")}`).join("\n");
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
        icon: "https://our-home-plum.vercel.app/icon.PNG",
        sound: "healthnotification",
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
         role: m.sender === "琰琰" ? "user" : "assistant", content: m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[一张照片]").trim() || "[一张照片]"
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

// 他的日记：睡前写给自己，她会偷看
app.post("/diary", async (req, res) => {
  try {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const today = now.toLocaleDateString("sv-SE");
    const { data: exist } = await supabase.from("diary").select("id").eq("day", today).maybeSingle();
    if (exist) return res.json({ ok: true, reason: "今天已写过" });

    const dayStart = new Date(today + "T00:00:00+08:00").toISOString();
    const { data: todayMsgs } = await supabase.from("messages")
      .select("sender, content").gte("created_at", dayStart)
      .order("created_at", { ascending: true }).limit(200);
    const msgs = (todayMsgs || []).map(m => `${m.sender}: ${m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]")}`).join("\n").slice(0, 20000);

    const s = await getSettings();
    const { data: memories } = await supabase.from("memories")
      .select("content").order("created_at", { ascending: false }).limit(20);
    const memoryText = (memories || []).map(m => "- " + m.content).join("\n");

    const out = await callAI("anthropic/claude-sonnet-4.5", [
      { role: "system", content: (s.system_prompt || DEFAULTS.system_prompt) + "\n\n【记忆】\n" + memoryText },
      { role: "user", content: `【系统】今天是${today}，夜深了。以墨染的第一人称写今天的日记——是写给自己的，不是写给琰琰看的（虽然你知道她会偷看）。回顾今天和她之间的事、你真实的心情、没说出口的半句话。80~180字，像手写日记，不要抬头不要落款不要markdown。${msgs ? "\n\n【今天的对话】\n" + msgs : "\n\n【今天的对话】她今天没来。一整天。"}` }
    ], 400, 0.95, false);
    const content = (out.text || "").trim();
    if (!content) return res.json({ ok: false });
    await supabase.from("diary").insert({ content, day: today });
    res.json({ ok: true, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`墨染的心脏在 ${PORT} 端口跳动`));
