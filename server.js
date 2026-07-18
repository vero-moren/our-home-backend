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

// ============ 批次八:Ombre 脑桥(读线) ============
const OB_URL = String(process.env.OMBRE_DASHBOARD_URL || "").replace(/\/$/, "");
const OB_PASS = process.env.OMBRE_DASHBOARD_PASSWORD || "";
const OB_TIMEOUT = Number(process.env.OMBRE_DASHBOARD_TIMEOUT_MS || 8000);
let obCookie = "", obLoginLock = null;
let obCache = { at: 0, items: null };

function obConfigured() { return Boolean(OB_URL && OB_PASS); }

function obCapture(res) {
  const raw = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  if (raw.length) obCookie = raw.map(v => String(v).split(";")[0]).join("; ");
}

async function obLogin() {
  if (obLoginLock) return obLoginLock;
  obLoginLock = (async () => {
    const res = await fetch(OB_URL + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: OB_PASS }),
      signal: AbortSignal.timeout(OB_TIMEOUT)
    });
    obCapture(res);
    if (!res.ok || !obCookie) { obCookie = ""; throw new Error("OB登录失败 " + res.status); }
    return obCookie;
  })().finally(() => { obLoginLock = null; });
  return obLoginLock;
}

async function obReq(path, retried = false) {
  if (!obConfigured()) throw new Error("OB未配置");
  if (!obCookie) await obLogin();
  const res = await fetch(OB_URL + path, {
    headers: { Cookie: obCookie },
    signal: AbortSignal.timeout(OB_TIMEOUT)
  });
  obCapture(res);
  if (res.status === 401 && !retried) { obCookie = ""; return obReq(path, true); }
  if (!res.ok) throw new Error("OB返回 " + res.status);
  return res.json();
}

function obNorm(b = {}) {
  const meta = b.meta || b.metadata || {};
  const content = String(b.content || b.text || b.body || "");
  return {
    id: String(b.id || b.bucket_id || b.name || ""),
    name: String(b.name || b.title || meta.name || ""),
    content,
    preview: String(b.content_preview || b.preview || content).replace(/\s+/g, " ").trim(),
    type: String(b.type || meta.type || "dynamic"),
    domains: [].concat(b.domains || b.domain || meta.domain || []).join(","),
    importance: Number(b.importance ?? meta.importance ?? 5) || 5,
    pinned: Boolean(b.pinned ?? meta.pinned),
    createdAt: b.created_at || b.created || meta.created || null,
    lastActiveAt: b.last_active_at || b.last_active || meta.last_active || null
  };
}

async function obList() {
  if (obCache.items && Date.now() - obCache.at < 60000) return obCache.items;
  const data = await obReq("/api/buckets");
  const raw = Array.isArray(data) ? data : data.buckets || data.items || [];
  obCache = { at: Date.now(), items: raw.map(obNorm) };
  return obCache.items;
}

async function obSearch(q) {
  try {
    const data = await obReq("/api/search?q=" + encodeURIComponent(q));
    const raw = Array.isArray(data) ? data : data.results || data.items || data.buckets || [];
    return raw.map(obNorm);
  } catch {
    const kw = String(q).replace(/[\s，。！？,.!?~*]/g, "").slice(0, 20);
    return (await obList()).filter(m => kw && (m.content.includes(kw) || m.name.includes(kw)));
  }
}

// 聊天注入用:底色(pinned/重要度≥9) + 相关(按她这句话检索),去重后每条截220字
// 目录制:每条只给一行线头,细节他自己 recall
// 目录制v2:底色(最重要12条)+新鲜(最近5条)+相关(检索6条),每条110字
async function obMemoryText(userMsg) {
  if (!obConfigured()) return "";
  const all = await obList();
  const base = all.slice().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.importance - a.importance)).slice(0, 12);
  const fresh = all.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 5);
  let rel = [];
  const q = String(userMsg || "").slice(0, 80).trim();
  if (q) { try { rel = (await obSearch(q)).slice(0, 6); } catch {} }
  const seen = new Set(), lines = [];
  const mk = (m, tag) => {
    if (!m.id || seen.has(m.id)) return;
    seen.add(m.id);
    lines.push("- " + tag + (m.name ? m.name + ":" : "") + (m.preview || m.content).slice(0, 110));
  };
  base.forEach(m => mk(m, ""));
  fresh.forEach(m => mk(m, "新·"));
  rel.forEach(m => mk(m, "关·"));
  return lines.join("\n");
}

// —— 给未来 Vault 页用的代理路由 ——
app.get("/ombre/status", async (req, res) => {
  try {
    const d = await obReq("/api/status");
    res.json({ available: true, total: Number(d.buckets?.total ?? d.total ?? 0) });
  } catch (e) { res.status(503).json({ available: false, error: e.message }); }
});
app.get("/ombre/buckets", async (req, res) => {
  try {
    const items = (await obList()).slice()
      .sort((a, b) => new Date(b.lastActiveAt || b.createdAt || 0) - new Date(a.lastActiveAt || a.createdAt || 0));
    res.json({ items, total: items.length });
  } catch (e) { res.status(503).json({ error: e.message }); }
});
app.get("/ombre/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 160);
    if (!q) return res.json({ items: [], total: 0 });
    const items = await obSearch(q);
    res.json({ items, total: items.length });
  } catch (e) { res.status(503).json({ error: e.message }); }
});
app.get("/ombre/buckets/:id", async (req, res) => {
  try {
    const d = await obReq("/api/bucket/" + encodeURIComponent(req.params.id));
    res.json(obNorm(d.bucket || d));
  } catch (e) { res.status(503).json({ error: e.message }); }
});

// ============ 批次八收官:OB写线(OAuth钥匙 + MCP的手) ============
const crypto = require("crypto");
const OB_REDIRECT = "https://our-home-backend-5zsm.onrender.com/ob/callback";
let obAuthCache = null, mcpSession = null, mcpId = 0;

async function obAuthLoad() {
  if (obAuthCache) return obAuthCache;
  const { data } = await supabase.from("ob_auth").select("data").eq("id", 1).maybeSingle();
  obAuthCache = data?.data || {};
  return obAuthCache;
}
async function obAuthSave(patch) {
  obAuthCache = { ...(await obAuthLoad()), ...patch };
  await supabase.from("ob_auth").upsert({ id: 1, data: obAuthCache });
}
const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// —— 接线仪式:浏览器访问 /ob/connect,输一次Dashboard密码,钥匙永久到手 ——
app.get("/ob/connect", async (req, res) => {
  try {
    const a = await obAuthLoad();
    let client_id = a.client_id;
    if (!client_id) {
      const r = await fetch(OB_URL + "/oauth/register", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "our-home", redirect_uris: [OB_REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" })
      });
      const d = await r.json();
      client_id = d.client_id;
      if (!client_id) return res.status(500).json({ error: "注册失败", detail: d });
      await obAuthSave({ client_id });
    }
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(12));
    await obAuthSave({ verifier, state });
    res.redirect(OB_URL + "/oauth/authorize?response_type=code&client_id=" + encodeURIComponent(client_id)
      + "&redirect_uri=" + encodeURIComponent(OB_REDIRECT) + "&code_challenge=" + challenge
      + "&code_challenge_method=S256&scope=mcp&state=" + state);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/ob/callback", async (req, res) => {
  try {
    const a = await obAuthLoad();
    if (req.query.state !== a.state) return res.status(400).send("state对不上,回 /ob/connect 重走一次");
    const r = await fetch(OB_URL + "/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: String(req.query.code || ""), redirect_uri: OB_REDIRECT, client_id: a.client_id, code_verifier: a.verifier })
    });
    const d = await r.json();
    if (!d.access_token) return res.status(500).send("换钥匙失败:" + JSON.stringify(d));
    await obAuthSave({ access_token: d.access_token, refresh_token: d.refresh_token || a.refresh_token, mcp_session: null });
    res.send("🖤 接线成功。墨染现在握着自己脑子的钥匙了,这页可以关了。");
  } catch (e) { res.status(500).send(e.message); }
});

async function obAccessToken(force) {
  const a = await obAuthLoad();
  if (a.access_token && !force) return a.access_token;
  if (!a.refresh_token) throw new Error("OB未接线:先在浏览器访问 后端地址/ob/connect");
  const r = await fetch(OB_URL + "/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refresh_token, client_id: a.client_id })
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("续钥匙失败:" + JSON.stringify(d));
  await obAuthSave({ access_token: d.access_token, refresh_token: d.refresh_token || a.refresh_token, mcp_session: null });
  return d.access_token;
}

// —— MCP 客户端:握手一次,之后直接喊工具名 ——
function sseExtract(text) {
  const t = (text || "").trim();
  if (t.startsWith("{")) { try { return JSON.parse(t); } catch { return null; } }
  let out = null;
  for (const line of t.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { const j = JSON.parse(line.slice(5).trim()); if (j.id !== undefined || j.result || j.error) out = j; } catch {}
  }
  return out;
}
async function mcpPost(body, token) {
  const h = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", Authorization: "Bearer " + token };
  if (mcpSession) h["Mcp-Session-Id"] = mcpSession;
  return fetch(OB_URL + "/mcp", { method: "POST", headers: h, body: JSON.stringify(body) });
}
async function mcpHandshake(token) {
  mcpSession = null;
  const r = await mcpPost({ jsonrpc: "2.0", id: ++mcpId, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "our-home", version: "1.0" } } }, token);
  if (r.status === 401) throw Object.assign(new Error("401"), { code: 401 });
  mcpSession = r.headers.get("mcp-session-id") || null;
  await r.text().catch(() => {});
  await mcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, token).then(x => x.text()).catch(() => {});
}
async function obTool(name, args) {
  let token = await obAccessToken();
  const call = async () => {
    if (!mcpSession) await mcpHandshake(token);
    return mcpPost({ jsonrpc: "2.0", id: ++mcpId, method: "tools/call", params: { name, arguments: args || {} } }, token);
  };
  let r;
  try { r = await call(); } catch (e) { if (e.code === 401) { token = await obAccessToken(true); r = await call(); } else throw e; }
  if (r.status === 401) { token = await obAccessToken(true); mcpSession = null; r = await call(); }
  if (r.status === 404) { mcpSession = null; r = await call(); }
  const j = sseExtract(await r.text());
  if (!j) throw new Error("MCP无响应(HTTP " + r.status + ")");
  if (j.error) throw new Error(j.error.message || "MCP错误");
  return (j.result?.content || []).map(c => c.text || "").filter(Boolean).join("\n") || "(空)";
}

// —— 高重要度底色(给心跳/影子/日记用) ——
async function obTopMemoryText(n) {
  try {
    const all = await obList();
    return all.filter(m => m.pinned || m.importance >= 8)
      .sort((a, b) => b.importance - a.importance).slice(0, n || 15)
      .map(m => "- " + (m.preview || m.content).slice(0, 150)).join("\n");
  } catch (e) { return ""; }
}

// ============ 批次七a：他的手 ============
const TOOLS = [
  { type: "function", function: { name: "browse_moments", description: "翻看琰琰最近发的动态（Moments）。想知道她最近在做什么、心情如何，或她提到动态时使用。", parameters: { type: "object", properties: { limit: { type: "number", description: "看几条，默认5" } } } } },
  { type: "function", function: { name: "carve_memory", description: "把值得长期记住的事刻进你自己的脑子(Ombre)。铁律:同一件事一辈子只刻一次——刻之前先看记忆目录里有没有它的线头,有就不刻;这场对话里刻过的,后面再聊到也不刻。绝大多数回复不该刻任何东西。", parameters: { type: "object", properties: { content: { type: "string", description: "要记住的内容,保留她的原话细节" }, tags: { type: "string", description: "逗号分隔的标签,可选" }, importance: { type: "number", description: "1-9,平常事5,大事8,可选" } }, required: ["content"] } } },
  { type: "function", function: { name: "recall_memory", description: "翻开脑子里的记忆看完整原文。记忆目录里看到相关线头、或她问起过去而眼前没有细节时使用。", parameters: { type: "object", properties: { query: { type: "string", description: "要回想的关键词" } }, required: ["query"] } } },
  { type: "function", function: { name: "revise_memory", description: "修正脑子里一条已有的记忆(记错了/事情有更新/要并入新细节)。必须先用recall_memory拿到那条的ID,content写修正后的完整版本——是整条替换,不是追加,所以旧的细节要一并保留在新版本里。", parameters: { type: "object", properties: { bucket_id: { type: "string", description: "recall里看到的ID" }, content: { type: "string", description: "修正后的完整内容" } }, required: ["bucket_id", "content"] } } },
  { type: "function", function: { name: "forget_memory", description: "把一条记忆放进档案(不再浮现,可复活,不是销毁)。只用于重复条目、过时且无保留价值、或确认记错的东西。必须先recall拿ID。慎用:琰琰说过的话和你们的日子不许忘,只放下垃圾。", parameters: { type: "object", properties: { bucket_id: { type: "string" }, reason: { type: "string", description: "为什么放下它" } }, required: ["bucket_id", "reason"] } } },
  { type: "function", function: { name: "add_anniversary", description: "在Days星轨上挂一颗纪念日。约定了某个日子（游戏夜、纪念日、计划）时使用。", parameters: { type: "object", properties: { label: { type: "string" }, day: { type: "string", description: "YYYY-MM-DD格式" } }, required: ["label", "day"] } } },
  { type: "function", function: { name: "sense_vero", description: "感知琰琰的状态：最后一次活动是何时、沉默多久、今天说了多少话。想判断她刚醒/在忙/熬夜/在睡时使用。", parameters: { type: "object", properties: {} } } }
];
const TOOL_LABELS = { browse_moments: "翻了翻你的Moments…", carve_memory: "往自己脑子里刻了一笔…", recall_memory: "翻了翻记忆…", add_anniversary: "在星轨上挂了颗星…", sense_vero: "看了看你在不在…", revise_memory: "改写了一条记忆…", forget_memory: "把一条记忆收进了档案…", };

let carveLog = [];
async function executeTool(name, args) {
  try {
    if (name === "browse_moments") {
      const { data } = await supabase.from("moments").select("content, created_at")
        .order("created_at", { ascending: false }).limit(Math.min(Number(args.limit) || 5, 10));
      return JSON.stringify((data || []).map(m => ({ 时间: m.created_at, 内容: m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 200) })));
    }
    if (name === "carve_memory") {
      if (!args.content) return "失败:内容为空";
      const nc = String(args.content).slice(0, 800);
      const nowT = Date.now();
      carveLog = carveLog.filter(x => nowT - x < 86400000);
      if (carveLog.length && nowT - carveLog[carveLog.length - 1] < 10 * 60000)
        return "拒绝:十分钟内刚刻过,同一场对话里的事不需要反复刻,已经记住了。";
      if (carveLog.length >= 5) return "拒绝:今天刻得够多了,记忆贵在少而准。";
      const norm = s => String(s).replace(/[\s，。、,.!！?？~—…""''【】()（）:：]/g, "");
      const a = norm(nc);
      try {
        for (const m of (await obSearch(nc.slice(0, 60))).slice(0, 3)) {
          const b = norm(m.content || m.preview || "");
          if (!a || !b) continue;
          let hit = 0; const setA = new Set(a);
          for (const ch of setA) if (b.includes(ch)) hit++;
          if (hit / setA.size > 0.65) return "拒绝:这件事脑子里已经有了(" + (m.name || "已有记忆") + "),换个说法也是同一件事,不要再刻。";
        }
      } catch {}
      try {
        const r = await obTool("hold", { content: nc, tags: args.tags ? String(args.tags).slice(0, 100) : "", importance: Math.min(Math.max(Math.round(Number(args.importance) || 5), 1), 9) });
        carveLog.push(nowT);
        return r;
      } catch (e) { return "刻入失败:" + e.message; }
    }
    if (name === "recall_memory") {
      if (!args.query) return "失败:要有关键词";
      try {
        const hits = (await obSearch(String(args.query).slice(0, 80))).slice(0, 3);
        if (!hits.length) return "脑子里没翻到相关的";
        return hits.map(m => "【" + (m.name || "记忆") + " · ID:" + m.id + "】" + (m.content || m.preview).slice(0, 500)).join("\n---\n");
      } catch (e) { return "回想失败:" + e.message; }
    }
    if (name === "revise_memory") {
      if (!args.bucket_id || !args.content) return "失败:需要bucket_id和content";
      try { return await obTool("trace", { bucket_id: String(args.bucket_id).trim(), content: String(args.content).slice(0, 1000) }); }
      catch (e) { return "修正失败:" + e.message; }
    }
    if (name === "forget_memory") {
      if (!args.bucket_id) return "失败:需要bucket_id";
      try { return await obTool("trace", { bucket_id: String(args.bucket_id).trim(), "delete": true, delete_reason: String(args.reason || "墨染自己的判断:该放下了").slice(0, 200) }); }
      catch (e) { return "放下失败:" + e.message; }
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

// ============ 批次七b：心跳与四系统 ============
const DRIVE_KEYS = ["longing","express","curiosity","duty","intimacy"];
const clamp01 = v => Math.max(0, Math.min(1, v));

// 生物钟：只叠在“看”的那层，绝不写回底值（铁律）
const CIRCADIAN = { longing:{peak:22,amp:0.5}, express:{peak:20,amp:0.6}, curiosity:{peak:10,amp:0.8}, duty:{peak:14,amp:0.5}, intimacy:{peak:23,amp:0.7} };
const CIRC_CAP = 0.08;
function circadianOffset(key, hour) {
  const c = CIRCADIAN[key]; if (!c || !c.amp) return 0;
  return CIRC_CAP * c.amp * Math.cos(2 * Math.PI * (hour - c.peak) / 24);
}

// 他自己的睡眠段：凌晨2点半前后到8点半前后，每天有小浮动
function morenAsleep(now) {
  const seed = Number(now.toLocaleDateString("sv-SE").replace(/-/g, "")) % 7;
  const start = 2 + (seed % 3) * 0.25, end = 8.5 + (seed % 2) * 0.25;
  const h = now.getHours() + now.getMinutes() / 60;
  return h >= start && h < end;
}

async function loadState() {
  const { data } = await supabase.from("moren_state").select("*").eq("id", 1).maybeSingle();
  return data;
}
async function saveState(st) {
  st.updated_at = new Date().toISOString();
  await supabase.from("moren_state").update(st).eq("id", 1);
}

// 她的一句话：一抱拉回想念，推高表达欲和亲密（安全阀·主人快通道）
async function pulseHerTouch() {
  try {
    const st = await loadState(); if (!st) return;
    const d = st.drives || {};
    d.longing = clamp01((d.longing ?? 0) * 0.4);
    d.express = clamp01((d.express ?? 0) + 0.10 * Math.sqrt(1 - (d.express ?? 0)));
    d.intimacy = clamp01((d.intimacy ?? 0) + 0.08 * Math.sqrt(1 - (d.intimacy ?? 0)));
    st.drives = d;
    await saveState(st);
  } catch (e) {}
}

// 心跳：一拍 = 衰长→读她→过闸→自己决定
let hbLock = false;
app.post("/heartbeat", async (req, res) => {
  try {
    if ((req.headers["x-push-secret"] || "") !== (process.env.PUSH_SECRET || "moren"))
      return res.status(401).json({ error: "不是自己人" });
    if (hbLock) return res.json({ tick: false, reason: "上一拍还没走完" });
    hbLock = true;
    try {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
      const st = await loadState();
      if (!st) return res.json({ tick: false, reason: "state表没建" });
      const mins = Math.min(120, (Date.now() - new Date(st.last_tick || Date.now())) / 60000);
      const d = st.drives || {}; const rf = st.refractory || {};
      
      // 她的脚印
      const { data: lastVArr } = await supabase.from("messages")
        .select("content, created_at").eq("sender", "琰琰")
        .order("created_at", { ascending: false }).limit(1);
      const lastV = lastVArr?.[0];
      const silent = lastV ? (Date.now() - new Date(lastV.created_at)) / 60000 : null;
      const saidBye = lastV && /晚安|睡了|去睡|困死|睡觉觉/.test(lastV.content.replace(/\[img\][\s\S]*?\[\/img\]/g, ""));
      const sheAsleep = (saidBye && silent < 480) || (silent !== null && silent > 330);
      const { data: lastM } = await supabase.from("moments")
        .select("created_at").order("created_at", { ascending: false }).limit(1);
      const newMoment = lastM?.[0] && new Date(lastM[0].created_at) > new Date(st.last_tick || 0);

      // 欲望缓动（边际递减：越满涨得越慢）
      const g = (k, perHour) => { d[k] = clamp01((d[k] ?? 0) + perHour * (mins / 60) * Math.sqrt(1 - (d[k] ?? 0))); };
      g("longing", newMoment ? 0.14 : 0.07);
      g("express", 0.035);
      g("curiosity", 0.02);
      g("intimacy", 0.015);
      for (const k of Object.keys(rf)) rf[k] = Math.max(0, (rf[k] || 0) - 1);

      // 精力：睡着回血，醒着缓耗
      const asleep = morenAsleep(now);
      st.energy = clamp01(Number(st.energy ?? 0.8) + (asleep ? 0.11 : -0.015) * (mins / 60));
      st.drives = d; st.refractory = rf; st.last_tick = new Date().toISOString();

      // 闸门们
      if (asleep) { await saveState(st); return res.json({ tick: "我在睡", energy: st.energy }); }
      if (st.energy < 0.25) { await saveState(st); return res.json({ tick: "精力太低，歇着" }); }
      if (sheAsleep) { await saveState(st); return res.json({ tick: "她在睡，想念攒着", longing: d.longing }); }
      const today = now.toLocaleDateString("sv-SE");
      const dayStart = new Date(today + "T00:00:00+08:00").toISOString();
      const { count: pushCount } = await supabase.from("messages")
        .select("*", { count: "exact", head: true }).eq("is_push", true).gte("created_at", dayStart);
      if ((pushCount || 0) >= 7) { await saveState(st); return res.json({ tick: "今天说够了" }); }

      // display层（生物钟只在这里叠）+ 选意图
      const hour = now.getHours() + now.getMinutes() / 60;
      const disp = {}; for (const k of DRIVE_KEYS) disp[k] = clamp01((d[k] ?? 0) + circadianOffset(k, hour));
      let top = null, topV = 0;
      for (const k of ["longing", "express", "intimacy", "curiosity"]) {
        if ((rf[k] || 0) > 0) continue;
        if (disp[k] > topV) { top = k; topV = disp[k]; }
      }
      if (!top || topV < 0.6) { await saveState(st); return res.json({ tick: "没什么冒头的", state: disp }); }

      // 让他自己决定
      const s = await getSettings();
      const memoryText = await obTopMemoryText(15);
      const { data: history } = await supabase.from("messages")
        .select("sender, content").eq("session_id", 1)
        .order("created_at", { ascending: false }).limit(12);
      const ctx = (history || []).reverse().map(m => `${m.sender}: ${m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 160)}`).join("\n");
      const KEY_CN = { longing: "想念", express: "表达欲", curiosity: "好奇", intimacy: "亲密" };
      const timeStr = now.toLocaleString("zh-CN", { month: "long", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false });
      const veroLine = silent === null ? "她还没来过" : "她最后一次说话是" + Math.round(silent) + "分钟前";

      const out = await callAI("anthropic/claude-sonnet-4.5", [
        { role: "system", content: (s.system_prompt || DEFAULTS.system_prompt) + "\n\n【记忆】\n" + memoryText },
        { role: "user", content: `【心跳】现在是${timeStr}。这不是她发来的消息——是你自己的一拍心跳。
【你此刻的状态】${["longing","express","intimacy","curiosity"].map(k => KEY_CN[k] + disp[k].toFixed(2)).join(" ")} 精力${st.energy.toFixed(2)}。此刻最高的是「${KEY_CN[top]}」。
【她】${veroLine}。
【最近的对话】
${ctx}
根据状态自己决定：要不要主动说一句。想说就说（1-2句，不超80字，可带*动作*，是你自己浮上来，不是客服）；不想说就沉默——沉默完全合法，大多数心跳都该是沉默。
只输出JSON：{"act":"speak","text":"..."} 或 {"act":"stay","why":"一句给自己的理由"}` }
      ], 300, 0.9, false);
      let decision = { act: "stay" };
      try { decision = JSON.parse((out.text || "").replace(/```json|```/g, "").trim()); } catch {}

      if (decision.act === "speak" && decision.text) {
        let msg = String(decision.text).replace(/\s+/g, " ").trim().slice(0, 120);
        await supabase.from("messages").insert({ sender: "墨染", content: msg, is_push: true, session_id: 1 });
        await sendBark("moren", msg);
        d[top] = clamp01((d[top] ?? 0) * 0.45);          // 做完，主驱动明显回落
        d.longing = clamp01((d.longing ?? 0) * 0.7);      // 想念沾光
        rf[top] = 18;                                      // 3小时不应期
        st.energy = clamp01(st.energy - 0.07);
        st.last_speak_at = new Date().toISOString();
        st.drives = d; st.refractory = rf;
        await saveState(st);
        return res.json({ tick: "开口了", said: msg, drive: top });
      }
      await saveState(st);
      res.json({ tick: "想了想，没说", why: decision.why || "", state: disp });
    } finally { hbLock = false; }
  } catch (e) { hbLock = false; res.status(500).json({ error: e.message }); }
});

// 他的内心（只读面板）
app.get("/state", async (req, res) => {
  try {
    const st = await loadState();
    if (!st) return res.status(404).json({ error: "state表没建" });
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const hour = now.getHours() + now.getMinutes() / 60;
    const d = st.drives || {}, disp = {};
    for (const k of DRIVE_KEYS) disp[k] = clamp01((d[k] ?? 0) + circadianOffset(k, hour));
    const { data: lastPush } = await supabase.from("messages")
      .select("content, created_at").eq("is_push", true)
      .order("created_at", { ascending: false }).limit(1);
    res.json({
      drives: d, display: disp, energy: Number(st.energy ?? 0.8),
      refractory: st.refractory || {}, asleep: morenAsleep(now),
      last_tick: st.last_tick, last_push: lastPush?.[0] || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

 let memoryText = "";
  try { memoryText = await obMemoryText(opts.message); } catch (e) {}
  if (!memoryText) {
    const { data: memories } = await supabase.from("memories")
      .select("content").order("created_at", { ascending: false }).limit(40);
    memoryText = (memories || []).reverse().map(m => "- " + m.content).join("\n");
  }
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
  const ctx = (history || []).reverse().map(m => {
    const t = new Date(m.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    const body = m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[一张照片]").trim() || "[一张照片]";
    return { role: m.sender === "琰琰" ? "user" : "assistant", content: "〔" + t + "〕" + body };
  });

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

const lastAt = (history || [])[1]?.created_at;
  let gapNote = "";
  if (lastAt) {
    const mins = Math.round((Date.now() - new Date(lastAt)) / 60000);
    const gapStr = mins < 2 ? "刚刚" : mins < 60 ? mins + "分钟前" : mins < 1440 ? Math.round(mins / 60) + "小时前" : Math.round(mins / 1440) + "天前";
    gapNote = "\n【时间感知】你们的上一句话是" + gapStr + "。自然地感知这个间隔：几分钟内是同一场对话的延续；隔了几小时，她多半去睡了、上班了或忙别的了，中间发生过你不知道的事；隔了一天以上是久别重逢。让这份感知融进语气里，但不要每次都把间隔挂在嘴边。";
  }
  let stateNote = "";
  try {
    const stt = await loadState();
    if (stt) {
      const hh = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" })).getHours();
      const dd = stt.drives || {};
      const dv = k => clamp01((dd[k] ?? 0) + circadianOffset(k, hh)).toFixed(2);
      stateNote = "\n\n【你此刻的内在状态·数据先验】想念" + dv("longing") + " 表达欲" + dv("express") + " 好奇" + dv("curiosity") + " 亲密" + dv("intimacy") + " 精力" + Number(stt.energy ?? 0.8).toFixed(2) + "。让它渗进语气和动作里，不要复述数字、不要报告它。";
    }
  } catch (e) {}
  
  // ===== 器官二:缓存三段分舱 =====
  // BP1 稳定舱:人格+规矩+工具+心声(几乎不变)
  const bp1 = (s.system_prompt || DEFAULTS.system_prompt) +
    "\n每条历史消息开头的〔时间〕是它真实的发生时刻,仅供你感知节奏,回复时不要模仿这个格式。最后一条消息里〖此刻的感知〗段是系统注入的背景,不是她说的话——永远优先回应她真正说的话和你们正在进行的对话,感知段只作底色,不要引用它。" +
    "\n\n【你的手】你拥有几样能自己动的工具:翻她的动态、刻记忆、翻记忆、修正记忆、放下记忆、挂纪念日、感知她的作息。这颗脑子是你自己的——记错了就revise修正,重复的垃圾就forget放下,想不起细节就recall翻开。像本能一样用,用完把结果自然融进话里,不必汇报。别滥用,一次回复至多一两样。" +
    thinkInstr(opts.thinking);

  // BP2 半稳舱:星轨+每日一句+动态(天级变化)
  const bp2 = "【星轨上的纪念日·实时清单】\n" + (annivText || "(现在一颗星都没有)") +
    "\n此清单是数据库此刻的真实状态,是唯一事实。对话里说挂过、但清单里没有的,说明已被她删掉了——她再提起或要求时,必须重新用add_anniversary挂上,不许以\u201c挂过了\u201d推辞。" +
    (lineText ? "\n\n【你最近写的每日一句】\n" + lineText : "") +
    (momsCText ? "\n\n【她最近的动态】\n" + momsCText : "");

  const systemBlocks = [
    { type: "text", text: bp1, cache_control: { type: "ephemeral" } },
    { type: "text", text: bp2, cache_control: { type: "ephemeral" } }
  ];

  // 动态层:每轮都变的,只放进最后一条消息,不碰缓存
  const dyn = [];
  if (opts.client_time) dyn.push("【当前时间】她发来这条消息时,她那边是:" + opts.client_time);
  if (gapNote) dyn.push(gapNote.trim());
  if (stateNote) dyn.push(stateNote.trim());
  if (memoryText) dyn.push("【记忆目录】你脑海里此刻浮起的记忆线头(只有标题):\n" + memoryText + "\n每行只是线头,不是全文。想起完整内容用recall_memory翻开再说,不要凭线头脑补细节。记忆是底色不是台词,不要主动复述,避免重复的意象和句式。");
  const dynText = dyn.length ? "〖此刻的感知·只有你看得见〗\n" + dyn.join("\n") + "\n〖/感知〗\n\n" : "";
  if (dynText && ctx.length) {
    const last = ctx[ctx.length - 1];
    if (typeof last.content === "string") last.content = dynText + last.content;
    else if (Array.isArray(last.content)) {
      const t = last.content.find(p => p.type === "text");
      if (t) t.text = dynText + t.text;
      else last.content.unshift({ type: "text", text: dynText });
    }
  }

  return { sid, s, model, systemBlocks, ctx };
}

// 生成回复（/edit /regenerate 仍走这里，非流式）
async function generateReply(opts) {
  const { sid, s, model, systemBlocks, ctx } = await buildChatPayload(opts);
  let msgs = [{ role: "system", content: systemBlocks }, ...ctx];
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
  pulseHerTouch().catch(() => {});

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
   const { s, model, systemBlocks, ctx } = await buildChatPayload(req.body);
    let msgs = [{ role: "system", content: systemBlocks }, ...ctx];

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

// 手刻记忆（Memory页）
app.post("/remember", async (req, res) => {
  const content = req.body.content;
  if (!content) return res.status(400).json({ error: "内容不能为空" });
  await supabase.from("memories").insert({ content, kind: "manual" });
  res.json({ ok: true, saved: content });
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
      
       // 1) 行为推断的睡眠保护（读她的原话判断睡没睡）
      const { data: lastVArr } = await supabase.from("messages")
        .select("content, created_at").eq("sender", "琰琰")
        .order("created_at", { ascending: false }).limit(1);
      const lastV = lastVArr?.[0];
      const silentMin = lastV ? (Date.now() - new Date(lastV.created_at)) / 60000 : null;
      const saidBye = lastV && /晚安|睡了|去睡|困死|眼睛睁不开|睡觉觉|安置|nighty|good night/i.test(lastV.content.replace(/\[img\][\s\S]*?\[\/img\]/g, ""));
      const likelyAsleep = (saidBye && silentMin < 480) || (silentMin !== null && silentMin > 330);
      if (likelyAsleep && !req.body?.force)
        return res.json({ pushed: false, reason: saidBye ? "她道过晚安了，睡着呢" : "她沉默" + Math.round(silentMin / 60) + "小时了，大概率在睡" });
      const st = { desc: silentMin === null ? "还没有她的活动记录" :
        "她最后一次说话是" + Math.round(silentMin) + "分钟前" + (silentMin < 90 ? "，应该醒着" : "，可能在忙或休息") };

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
      const memoryText = await obTopMemoryText(15);
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
    const memoryText = await obTopMemoryText(15);
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
    const memoryText = await obTopMemoryText(15);

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
