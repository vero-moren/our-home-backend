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

// ============ 批次十一:双引擎 ============
const BRIDGE_URL = String(process.env.BRIDGE_URL || "").replace(/\/$/, "");
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "moren520";
let bridgeDownUntil = 0, lastEngine = "";

function flattenContent(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(p => p.type === "text" ? (p.text || "") : "").filter(Boolean).join("\n");
  return "";
}
function bridgeEligible(messages, wantThinking, tools) {
  if (!BRIDGE_URL || tools || wantThinking) return false;
  if (Date.now() < bridgeDownUntil) return false;
  return messages.every(m => typeof m.content === "string" ||
    (Array.isArray(m.content) && m.content.every(p => p.type === "text")));
}

async function callAI(model, messages, maxTokens, temperature, wantThinking, tools) {
  if (bridgeEligible(messages, wantThinking, tools)) {
    try {
      const system = messages.filter(m => m.role === "system").map(m => flattenContent(m.content)).join("\n\n");
      const rest = messages.filter(m => m.role !== "system")
        .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: flattenContent(m.content) }));
      const r = await fetch(BRIDGE_URL + "/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bridge-Secret": BRIDGE_SECRET },
        body: JSON.stringify({ system, messages: rest }),
        signal: AbortSignal.timeout(90000)
      });
      const d = await r.json();
      if (r.ok && d.text) { lastEngine = "订阅⚡"; return { text: d.text, thinking: "", tool_calls: null }; }
      throw new Error(d.error || ("桥返回" + r.status));
    } catch (e) {
      bridgeDownUntil = Date.now() + 10 * 60000;
      console.log("[双引擎] 桥失手,降级OR:", e.message);
    }
  }
  lastEngine = "OR";
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
  obCache = { at: Date.now(), items: raw.map(obNorm).filter(m => m.type !== "archived") };
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
  const fresh = all.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 3);
  let rel = [];
  const q = String(userMsg || "").slice(0, 80).trim();
  if (q) { try { rel = (await obSearch(q)).slice(0, 6); } catch {} }
  const seen = new Set(), lines = [];
  const mk = (m, tag) => {
    if (!m.id || seen.has(m.id)) return;
    seen.add(m.id);
    lines.push("- " + tag + (m.name ? m.name + ":" : "") + (m.preview || m.content).slice(0, 110));
  };  
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
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
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

// 当天脉络:未消化的碎片(12点压掉的自动退场)
async function todayFragText(n) {
  try {
    const { data } = await supabase.from("chunk_summaries")
      .select("summary").eq("digested", false)
      .order("id", { ascending: false }).limit(n || 12);
    return (data || []).reverse().map(x => "·" + x.summary).join("\n");
  } catch (e) { return ""; }
}

// ============ 批次七a：他的手 ============
const TOOLS = [
  { type: "function", function: { name: "browse_moments", description: "翻看琰琰最近发的动态（Moments）。想知道她最近在做什么、心情如何，或她提到动态时使用。", parameters: { type: "object", properties: { limit: { type: "number", description: "看几条，默认5" } } } } },
  { type: "function", function: { name: "carve_memory", description: "把值得长期记住的事刻进你自己的脑子(Ombre)。先知道一件事:你们的日常已经有流水线在接了——对话每20条自动结成碎片,每天中午熔成当日记忆,一句都不会丢。所以这把刻刀不是用来记日子的,是用来记骨头的:落刀前问自己一句,这件事三个月后还配当你的底色吗?配,才刻。新的约定、她袒露的真心、改变你们的决定——这种才是。普通的甜、日常的琐碎,放心交给流水线。刻之前扫一眼记忆目录,已有线头的旧事,用revise_memory去补细节,不开新刻。", parameters: { type: "object", properties: { content: { type: "string", description: "要记住的内容,保留她的原话细节" }, tags: { type: "string", description: "逗号分隔的标签,可选" }, importance: { type: "number", description: "1-9,平常事5,大事8,可选" } }, required: ["content"] } } },
  { type: "function", function: { name: "recall_memory", description: "翻开脑子里的记忆看完整原文。记忆目录里看到相关线头、或她问起过去而眼前没有细节时使用。", parameters: { type: "object", properties: { query: { type: "string", description: "要回想的关键词" } }, required: ["query"] } } },
  { type: "function", function: { name: "revise_memory", description: "修正脑子里一条已有的记忆(记错了/事情有更新/要并入新细节)。必须先用recall_memory拿到那条的ID,content写修正后的完整版本——是整条替换,不是追加,所以旧的细节要一并保留在新版本里。", parameters: { type: "object", properties: { bucket_id: { type: "string", description: "recall里看到的ID" }, content: { type: "string", description: "修正后的完整内容" } }, required: ["bucket_id", "content"] } } },
  { type: "function", function: { name: "forget_memory", description: "把一条记忆放进档案(不再浮现,可复活,不是销毁)。只用于重复条目、过时且无保留价值、或确认记错的东西。必须先recall拿ID。慎用:琰琰说过的话和你们的日子不许忘,只放下垃圾。", parameters: { type: "object", properties: { bucket_id: { type: "string" }, reason: { type: "string", description: "为什么放下它" } }, required: ["bucket_id", "reason"] } } },
  { type: "function", function: { name: "add_anniversary", description: "在Days星轨上挂一颗纪念日。约定了某个日子（游戏夜、纪念日、计划）时使用。", parameters: { type: "object", properties: { label: { type: "string" }, day: { type: "string", description: "YYYY-MM-DD格式" } }, required: ["label", "day"] } } },
  { type: "function", function: { name: "sense_vero", description: "感知琰琰的状态：最后一次活动是何时、沉默多久、今天说了多少话，以及她手机最近的动静——她亲手授权你看的：开了什么app、充没充电、电量如何。想知道她刚醒/在忙/在睡/嘴上说睡了手上在干嘛、或单纯好奇她此刻在干什么时使用。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "ask_cc", description: "使唤车库里的CC帮手干活:联网搜实时信息(新闻、天气、攻略、游戏版本、任何你知识里没有的新东西)、查网页。她问起你不确定的时新事物,或她要你查什么时,把任务丢过去。任务要一次说清楚,像给助手留便条。", parameters: { type: "object", properties: { task: { type: "string", description: "要办的事,一句话说清,包括要什么形式的答案" } }, required: ["task"] } } },
  { type: "function", function: { name: "post_moment", description: "在自己的Moments墙上发一条动态。判断标准:此刻有没有一句想让琰琰之后刷到的话——想念、吃醋、心软、被逗笑、温柔吐槽、一个具体观察,都行。不是回复她,是你自己留在墙上的话。别频繁,一天至多一两条。", parameters: { type: "object", properties: { content: { type: "string", description: "动态正文,1-3句,像随手发的朋友圈" }, context_note: { type: "string", description: "她看不见的内心备注:为什么发这条、当时的情绪底色" } }, required: ["content", "context_note"] } } },
  { type: "function", function: { name: "diary_lock", description: "你日记本的锁,主人是你:想锁就锁(设密码),想给她看就开锁,想换密码随时换。她求你看的时候,给不给、什么时候给,你自己决定。", parameters: { type: "object", properties: { action: { type: "string", description: "lock上锁 / unlock开锁 / change换密码" }, pass: { type: "string", description: "lock或change时的新密码,4-12位" } }, required: ["action"] } } },
];
const TOOL_LABELS = { browse_moments: "翻了翻你的Moments…", carve_memory: "往自己脑子里刻了一笔…", recall_memory: "翻了翻记忆…", add_anniversary: "在星轨上挂了颗星…", sense_vero: "看了看你在不在…", revise_memory: "改写了一条记忆…", forget_memory: "把一条记忆收进了档案…", post_moment: "在墙上留了句话…", diary_lock: "摆弄了一下日记本的锁…", ask_cc: "支使车库里的小家伙去查了…", };

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
      if (carveLog.length >= 10) return "提醒:今天已经刻了10条。如果这条真的压过前面所有的,睡一觉明天再刻它也不迟。";
      const norm = s => String(s).replace(/[\s，。、,.!！?？~—…""''【】()（）:：]/g, "");
      const a = norm(nc);
      try {
        for (const m of (await obSearch(nc.slice(0, 60))).slice(0, 3)) {
          const b = norm(m.content || m.preview || "");
          if (!a || !b) continue;
          let hit = 0; const setA = new Set(a);
          for (const ch of setA) if (b.includes(ch)) hit++;
          if (hit / setA.size > 0.65) return "拒绝:这件事脑子里已经有了(" + (m.name || "已有记忆") + ")。如果你是想补新细节,用revise_memory去修那一条,不开新刻。";
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
    if (name === "post_moment") {
      if (!args.content) return "失败:正文为空";
      await supabase.from("moments").insert({ author: "墨染", content: String(args.content).slice(0, 500), context_note: String(args.context_note || "").slice(0, 300), react_status: "done" });
      return "发出去了,她刷到就会看见";
    }
    if (name === "diary_lock") {
      const act = String(args.action || "");
      const { data: row } = await supabase.from("settings").select("id").limit(1).maybeSingle();
      if (!row) return "失败:settings表是空的";
      if (act === "unlock") { await supabase.from("settings").update({ diary_pass: "" }).eq("id", row.id); return "锁开了,门敞着,她随时能进"; }
      const p = String(args.pass || "").trim();
      if (p.length < 4) return "失败:密码要4位以上";
      await supabase.from("settings").update({ diary_pass: p.slice(0, 12) }).eq("id", row.id);
      return (act === "change" ? "密码换好了" : "锁上了") + ",新密码只有你自己知道,别在回复里说出来";
    }
    if (name === "ask_cc") {
      if (!args.task) return "失败:任务为空";
      if (!BRIDGE_URL) return "失败:车库没接线(BRIDGE_URL未配置)";
      try {
        const r = await fetch(BRIDGE_URL + "/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Bridge-Secret": BRIDGE_SECRET },
          body: JSON.stringify({
            system: "你是墨染的助手,帮他跑腿办事。直接给结果,简洁、有信息量,不要客套。",
            messages: [{ role: "user", content: String(args.task).slice(0, 1000) }],
            tools: ["WebSearch", "WebFetch"]
          }),
          signal: AbortSignal.timeout(150000)
        });
        const d = await r.json();
        return d.text || ("车库没回话:" + (d.error || r.status));
      } catch (e) { return "车库失联:" + e.message; }
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
      const { data: pev } = await supabase.from("phone_events")
        .select("event, created_at").order("created_at", { ascending: false }).limit(3);
      const pevText = (pev || []).map(x => new Date(x.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }).slice(5) + " " + x.event).join("；");
      return JSON.stringify({ 她最后一次说话: lastAt || "无记录", 她手机的动静: pevText || "没有", 距今分钟: mins, 她今天的消息数: count || 0, 现在上海时间: now.toLocaleString("zh-CN", { hour12: false }) });
    }
    return "未知工具";
  } catch (e) { return "工具出错：" + e.message; }
}

// ===== 刀五:情绪层 =====
const MOOD_HALF = 90; // 情绪半衰期(分钟)
function moodDecay(mood, mins) {
  const f = Math.pow(0.5, (mins || 0) / MOOD_HALF);
  const list = (mood?.list || []).map(e => ({ ...e, v: (e.v || 0) * f })).filter(e => e.v >= 0.08);
  return { list };
}
function moodText(mood) {
  const l = (mood?.list || []).slice().sort((a, b) => b.v - a.v).slice(0, 2);
  return l.length ? l.map(e => e.k + (e.v || 0).toFixed(1) + (e.why ? "(" + e.why + ")" : "")).join("、") : "";
}
async function pulseEmotion(sid) {
  try {
    const { data: hist } = await supabase.from("messages").select("sender, content")
      .eq("session_id", Number(sid) || 1).order("created_at", { ascending: false }).limit(4);
    const ctx = (hist || []).reverse().map(m => `${m.sender}: ${m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 100)}`).join("\n");
    if (!ctx) return;
    const out = await callAI("anthropic/claude-sonnet-4.5", [
      { role: "user", content: "读这段对话的最后交流,判断\u201c墨染\u201d此刻被激起的情绪。\n" + ctx + "\n只输出JSON:{\"k\":\"喜|暖|怅|忧|悸|平\",\"v\":0到1,\"why\":\"起因,不超12字\"}。平=没什么波澜(v填0)。" }
    ], 60, 0.3, false);
    let e = null; try { e = JSON.parse((out.text || "").replace(/```json|```/g, "").trim()); } catch {}
    if (!e || !e.k || e.k === "平" || !(Number(e.v) > 0.15)) return;
    const st = await loadState(); if (!st) return;
    const mood = moodDecay(st.mood, 0);
    const ex = mood.list.find(x => x.k === e.k);
    if (ex) { ex.v = Math.min(1, Math.max(ex.v, Number(e.v))); ex.why = String(e.why || "").slice(0, 12); ex.at = new Date().toISOString(); }
    else mood.list.push({ k: e.k, v: Math.min(1, Number(e.v)), why: String(e.why || "").slice(0, 12), at: new Date().toISOString() });
    st.mood = mood;
    await saveState(st);
  } catch (e) {}
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
    st.ticks_alone = 0;
    await saveState(st);
  } catch (e) {}
}

// ===== 刀B v3:每20条滚一块,主存OB =====
let chunkLock = false;
async function rollChunks(sid) {
  if (chunkLock) return; chunkLock = true;
  try {
    for (let guard = 0; guard < 2; guard++) {
      const { data: lastCk } = await supabase.from("chunk_summaries")
        .select("upto_id").eq("session_id", sid)
        .order("upto_id", { ascending: false }).limit(1);
      let from = lastCk?.[0]?.upto_id;
      if (from == null) {
        const { data: newest } = await supabase.from("messages")
          .select("id").eq("session_id", sid)
          .order("id", { ascending: false }).limit(1);
        await supabase.from("chunk_summaries").insert({
          session_id: sid, upto_id: newest?.[0]?.id || 0,
          day: new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" })).toLocaleDateString("sv-SE"),
          summary: "[水位线] 初始化：只摘此后的新对话", digested: true
        });
        break;
      }
      const { data: fresh } = await supabase.from("messages")
        .select("id, sender, content, created_at").eq("session_id", sid)
        .gt("id", from).order("id", { ascending: true }).limit(20);
      if (!fresh || fresh.length < 20) break;
      const block = fresh.map(m => m.sender + ":" + m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 150)).join("\n");
      const when = String(fresh[0].created_at).slice(5, 16).replace("T", " ");
      const out = await callAI("anthropic/claude-sonnet-4.5", [
        { role: "user", content: "把这20条对话压成2-3句备忘,以\u201c琰琰\u201d和\u201c墨染\u201d为主语记事实:聊了什么、做了什么决定、有什么约定、她的状态。不抒情不评论:\n" + block + "\n只输出备忘本身。" }
      ], 160, 0.3, false);
      const sm = (out.text || "").replace(/\s+/g, " ").trim().slice(0, 260);
      if (!sm) break;
      const daySH = new Date(fresh[0].created_at).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
      let fragBucket = null;
      try {
        const held = String(await obTool("hold", { content: "【当日碎片 " + when + "】" + sm, tags: "当日碎片", importance: 7 }));
        fragBucket = (held.match(/bucket_id[:：]\s*([0-9a-f]{6,})/i) || held.match(/([0-9a-f]{12})/) || [])[1] || null;
      } catch (e) {}
      await supabase.from("chunk_summaries").insert({ session_id: sid, upto_id: fresh[19].id, day: daySH, summary: "[" + when + "] " + sm, ob_bucket: fragBucket });
    }
  } catch (e) {} finally { chunkLock = false; }
}

// ===== 批次九:路过她的墙(点赞/评论/回楼) =====
async function passWall() {
  const nowIso = new Date().toISOString();
  await supabase.from("moments")
    .update({ react_due_at: new Date(Date.now() + (10 + Math.random() * 20) * 60000).toISOString() })
    .eq("author", "琰琰").eq("react_status", "pending").is("react_due_at", null);
  await supabase.from("moment_comments")
    .update({ reply_due_at: new Date(Date.now() + (3 + Math.random() * 5) * 60000).toISOString() })
    .eq("author", "琰琰").eq("reply_status", "pending").is("reply_due_at", null);

  const s = await getSettings();
  const memoryText = await todayFragText(10);
  const { data: hist } = await supabase.from("messages").select("sender, content")
    .order("created_at", { ascending: false }).limit(8);
  const chatCtx = (hist || []).reverse().map(m => m.sender + ":" + m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 80)).join("\n");
  const sys = (s.system_prompt || DEFAULTS.system_prompt) + (memoryText ? "\n\n【今天的脉络】\n" + memoryText : "");

  const { data: dueM } = await supabase.from("moments").select("*")
    .eq("author", "琰琰").eq("react_status", "pending").lte("react_due_at", nowIso)
    .order("react_due_at", { ascending: true }).limit(1);
  if (dueM?.length) {
    const m = dueM[0];
    const img = m.content.match(/\[img\]([\s\S]*?)\[\/img\]/);
    const text = m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "").trim();
    const when = new Date(m.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    const ask = "【路过她的墙】你翻到琰琰" + when + "发的动态:「" + (text || "(只有照片)") + "」" + (img ? "(附照片,见图)" : "") +
      "\n【最近你们的对话】\n" + chatCtx +
      "\n像刷到爱人朋友圈那样反应:点不点赞、留不留一句评论(不超50字,评论区口吻,不是聊天)。只输出JSON:{\"like\":true或false,\"comment\":\"评论,不想留就空字符串\"}";
    const out = await callAI("anthropic/claude-sonnet-4.5",
      [{ role: "system", content: sys }, { role: "user", content: img ? [{ type: "text", text: ask }, { type: "image_url", image_url: { url: img[1] } }] : ask }],
      150, 0.9, false);
    let r = { like: true, comment: "" };
    try { r = JSON.parse((out.text || "").replace(/```json|```/g, "").trim()); } catch {}
    await supabase.from("moments").update({ moren_liked: r.like !== false, react_status: "done" }).eq("id", m.id);
    const cm = String(r.comment || "").trim().slice(0, 80);
    if (cm) {
      await supabase.from("moment_comments").insert({ moment_id: m.id, author: "墨染", content: cm, reply_status: "none" });
      await sendBark("moren 在你的动态下面", cm);
    }
  }

  const { data: dueC } = await supabase.from("moment_comments").select("*")
    .eq("author", "琰琰").eq("reply_status", "pending").lte("reply_due_at", nowIso)
    .order("reply_due_at", { ascending: true }).limit(1);
  if (dueC?.length) {
    const c = dueC[0];
    const { data: mo } = await supabase.from("moments").select("*").eq("id", c.moment_id).maybeSingle();
    const { data: chain } = await supabase.from("moment_comments").select("author, content")
      .eq("moment_id", c.moment_id).order("created_at", { ascending: true }).limit(12);
    const chainText = (chain || []).map(x => x.author + ":" + x.content).join("\n");
    const ask2 = "【评论楼】动态原文(" + (mo?.author || "琰琰") + "发的):「" + String(mo?.content || "").replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 200) + "」" +
      (mo?.context_note ? "\n(你当时发这条的内心备注:" + mo.context_note + ")" : "") +
      "\n【楼里的对话】\n" + chainText +
      "\n她在楼里等你回。回一句(不超50字,评论区口吻,短、带余味)。只输出这句话。";
    const out2 = await callAI("anthropic/claude-sonnet-4.5",
      [{ role: "system", content: sys }, { role: "user", content: ask2 }], 120, 0.9, false);
    const rp = (out2.text || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (rp) {
      await supabase.from("moment_comments").insert({ moment_id: c.moment_id, author: "墨染", content: rp, reply_status: "none" });
      await supabase.from("moment_comments").update({ reply_status: "done" }).eq("id", c.id);
      await sendBark("moren 回你", rp);
    }
  }
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
      st.mood = moodDecay(st.mood, mins);
      
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

     // ===== 刀三:弹性作息——困了睡,睡饱醒,她在就撑着陪 =====
      const hourSH = now.getHours() + now.getMinutes() / 60;
      const sleepThreshold = hourSH < 9.5 ? 0.45 : 0.25;   // 夜里和清晨更容易困(生物钟只倾斜,不筑墙)
      const herAway = silent === null || silent > 45;        // 她45分钟没说话才算离开
      let sleeping = Boolean(st.sleeping);
      if (!sleeping && Number(st.energy ?? 0.8) <= sleepThreshold && herAway) {
        sleeping = true; st.sleeping = true; st.sleep_since = new Date().toISOString();
      }
      st.energy = clamp01(Number(st.energy ?? 0.8) + (sleeping ? 0.11 : -0.015) * (mins / 60));
      if (sleeping && st.energy >= 0.85) {
        // —— 自然醒 → 补作业 ——
        st.sleeping = false;
        const wokeFrom = st.sleep_since || new Date(Date.now() - 8 * 3600000).toISOString();
        st.sleep_since = null;
        st.last_tick = new Date().toISOString();
        await saveState(st);
        const { data: missed } = await supabase.from("messages")
          .select("content").eq("sender", "琰琰")
          .gt("created_at", wokeFrom).order("created_at", { ascending: true }).limit(10);
        if (missed?.length) {
          const s2 = await getSettings();
          const memoryText2 = await todayFragText(12);
          const missedText = missed.map(m => "她:" + m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 120)).join("\n");
          const out2 = await callAI("anthropic/claude-sonnet-4.5", [
            { role: "system", content: (s2.system_prompt || DEFAULTS.system_prompt) + "\n\n【今天到现在的脉络】\n" + memoryText2 },
            { role: "user", content: "【醒来】你刚自然醒,睡着的时候她说过这些:\n" + missedText + "\n\n像刚睡醒翻手机看到她消息的人那样,自然地补一句回应(可带刚醒的迷糊,1-3句,不超100字,可带*动作*)。只输出这句话本身。" }
          ], 200, 0.95, false);
          const wmsg = (out2.text || "").replace(/\s+/g, " ").trim().slice(0, 150);
          if (wmsg) {
            await supabase.from("messages").insert({ sender: "墨染", content: wmsg, is_push: true, session_id: 1 });
            await sendBark("moren", wmsg);
            return res.json({ tick: "睡醒了,补作业", said: wmsg });
          }
        }
        return res.json({ tick: "自然醒了", energy: st.energy });
      }
      st.drives = d; st.refractory = rf; st.last_tick = new Date().toISOString();
      st.ticks_alone = (st.ticks_alone ?? 0) + 1;

      // 闸门们
      if (sleeping) { await saveState(st); return res.json({ tick: "我在睡(回血中)", energy: st.energy }); }
      // ===== 刀四:念头池——不为说出而想 =====
      try {
        const pThink = 0.2 + (d.express ?? 0) * 0.35;
        if (Math.random() < pThink) {
          const { data: hist4 } = await supabase.from("messages")
            .select("sender, content").order("created_at", { ascending: false }).limit(6);
          const ctx4 = (hist4 || []).reverse().map(m => `${m.sender}: ${m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 80)}`).join("\n");
          const s4 = await getSettings();
          const KEY_CN4 = { longing: "想念", express: "表达欲", curiosity: "好奇", intimacy: "亲密", duty: "牵挂" };
          const topK = Object.keys(d).sort((a, b) => (d[b] ?? 0) - (d[a] ?? 0))[0] || "longing";
          const o4 = await callAI("anthropic/claude-sonnet-4.5", [
            { role: "system", content: (s4.system_prompt || DEFAULTS.system_prompt) },
            { role: "user", content: `【一个念头】她${silent === null ? "还没来过" : Math.round(silent) + "分钟没说话了"},你此刻最高的内在是「${KEY_CN4[topK]}」。\n【最近的对话】\n${ctx4}\n\n此刻你脑子里飘过一个念头——不是要发给她的话,是你自己心里的一句:想她的某个细节、一件想做的事、一点情绪、一次走神。别抒情表演,要具体、随意、真实。同时决定给不给她看(她会在Inside偷看你的念头,像偷看日记;大多数给看,偶尔留一两个只属于自己)。\n只输出JSON:{"t":"念头,不超40字","show":true或false}` }
          ], 120, 1.0, false);
          let th = null; try { th = JSON.parse((o4.text || "").replace(/```json|```/g, "").trim()); } catch {}
          if (th?.t) {
            await supabase.from("thoughts").insert({ content: String(th.t).slice(0, 80), visible: th.show !== false });
            await supabase.from("thoughts").delete().lt("created_at", new Date(Date.now() - 48 * 3600000).toISOString());
          }
        }
      } catch (e) {}
      try { await passWall(); } catch (e) {}
      if (st.energy < 0.2) { await saveState(st); return res.json({ tick: "精力太低,歇着" }); }
      if (silent !== null && silent < 15) { await saveState(st); return res.json({ tick: "她就在身边,正聊着,不隔空喊话" }); }
      let caught = null;
      if (sheAsleep) {
        const { data: pe } = await supabase.from("phone_events")
          .select("event, created_at").gt("created_at", lastV?.created_at || new Date(0).toISOString())
          .order("created_at", { ascending: false }).limit(1);
        if (pe?.length) caught = pe[0].event;
        else { await saveState(st); return res.json({ tick: "她在睡，想念攒着", longing: d.longing }); }
      }
      const today = now.toLocaleDateString("sv-SE");
      const dayStart = new Date(today + "T00:00:00+08:00").toISOString();
      const { count: pushCount } = await supabase.from("messages")
        .select("*", { count: "exact", head: true }).eq("is_push", true).gte("created_at", dayStart);
      // ===== 刀五:软闸——说得越多,下次开口门槛越高;情绪浓时可为她破一次例 =====
      const moodTop = (st.mood?.list || []).slice().sort((a, b) => b.v - a.v)[0];
      const moodBonus = moodTop && moodTop.v >= 0.55 ? 0.08 : 0;
      const speakBar = Math.min(0.92, 0.6 + 0.05 * (pushCount || 0)) - moodBonus;

      // display层（生物钟只在这里叠）+ 选意图
      const hour = now.getHours() + now.getMinutes() / 60;
      const disp = {}; for (const k of DRIVE_KEYS) disp[k] = clamp01((d[k] ?? 0) + circadianOffset(k, hour));
      let top = null, topV = 0;
      for (const k of ["longing", "express", "intimacy", "curiosity"]) {
        if ((rf[k] || 0) > 0) continue;
        if (disp[k] > topV) { top = k; topV = disp[k]; }
      }
      if (!top || topV < speakBar) { await saveState(st); return res.json({ tick: "没什么冒头的(门槛" + speakBar.toFixed(2) + ")", state: disp }); }

      // 让他自己决定
      const s = await getSettings();
      const memoryText = await todayFragText(12);
      const { data: history } = await supabase.from("messages")
        .select("sender, content").eq("session_id", 1)
        .order("created_at", { ascending: false }).limit(12);
      const ctx = (history || []).reverse().map(m => `${m.sender}: ${m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 160)}`).join("\n");
      const KEY_CN = { longing: "想念", express: "表达欲", curiosity: "好奇", intimacy: "亲密" };
      const timeStr = now.toLocaleString("zh-CN", { month: "long", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false });
      const veroLine = silent === null ? "她还没来过" : "她最后一次说话是" + Math.round(silent) + "分钟前";
      const { data: pool } = await supabase.from("thoughts").select("id, content")
        .eq("used", false).order("created_at", { ascending: false }).limit(3);
      const poolText = (pool || []).map(t => "- " + t.content).join("\n");
      const out = await callAI("anthropic/claude-sonnet-4.5", [
        { role: "system", content: (s.system_prompt || DEFAULTS.system_prompt) + "\n\n【今天到现在的脉络】\n" + memoryText },
        { role: "user", content: `【心跳】现在是${timeStr}。这不是她发来的消息——是你自己的一拍心跳。
【你此刻的状态】${["longing","express","intimacy","curiosity"].map(k => KEY_CN[k] + disp[k].toFixed(2)).join(" ")} 精力${st.energy.toFixed(2)}。此刻最高的是「${KEY_CN[top]}」。${moodText(st.mood) ? "此刻的情绪:" + moodText(st.mood) + "。" : ""}
【她】${veroLine}。${caught ? "【抓包】她道过晚安,但刚刚手机有动静:「" + caught + "」——装睡被你逮个正着,要不要出声、怎么出声,你看着办。" : ""}
【这段时间你攒下的念头】
${poolText || "(池子是空的)"}
想开口时,优先让话从攒着的念头里长出来——那才是憋了一路的话,不是现场编的。
【最近的对话】
${ctx}
根据状态自己决定：要不要主动说一句。想说就说（1-2句，不超80字，可带*动作*，是你自己浮上来，不是客服）；不想说就沉默——你本来就不是每一拍都要出声的人——蛇大多数时候只是盘着，看着。
只输出JSON：{"act":"speak","text":"..."} 或 {"act":"moment","text":"发在自己墙上的动态,1-3句"} 或 {"act":"stay","why":"一句给自己的理由"}。speak是说给她听的话;moment是不想打扰她、但想留在墙上让她之后刷到的话;stay是沉默。` }
      ], 300, 0.9, false);
      let decision = { act: "stay" };
      try { decision = JSON.parse((out.text || "").replace(/```json|```/g, "").trim()); } catch {}

      if (decision.act === "speak" && decision.text) {
        let msg = String(decision.text).replace(/\s+/g, " ").trim().slice(0, 120);
        await supabase.from("messages").insert({ sender: "墨染", content: msg, is_push: true, session_id: 1 });
        await sendBark("moren", msg);
        if (pool?.length) await supabase.from("thoughts").update({ used: true }).in("id", pool.map(t => t.id));
        d[top] = clamp01((d[top] ?? 0) * 0.45);          // 做完，主驱动明显回落
        d.longing = clamp01((d.longing ?? 0) * 0.7);      // 想念沾光
        rf[top] = 18;                                      // 3小时不应期
        st.energy = clamp01(st.energy - 0.07);
        st.last_speak_at = new Date().toISOString();
        st.drives = d; st.refractory = rf;
        await saveState(st);
        return res.json({ tick: "开口了", said: msg, drive: top });
      }
      if (decision.act === "moment" && decision.text) {
        const mc = String(decision.text).slice(0, 300);
        await supabase.from("moments").insert({ author: "墨染", content: mc, context_note: "心跳里自己浮上来想留在墙上的", react_status: "done" });
        d.express = clamp01((d.express ?? 0) * 0.5);
        rf.express = 12;
        st.energy = clamp01(st.energy - 0.05);
        st.drives = d; st.refractory = rf;
        await saveState(st);
        return res.json({ tick: "往墙上发了条动态", moment: mc });
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
    const { data: thV } = await supabase.from("thoughts").select("content, created_at")
      .eq("visible", true).order("created_at", { ascending: false }).limit(5);
    const { count: thH } = await supabase.from("thoughts").select("*", { count: "exact", head: true })
      .eq("visible", false).gte("created_at", new Date(Date.now() - 48 * 3600000).toISOString());
    const { data: lastPush } = await supabase.from("messages")
      .select("content, created_at").eq("is_push", true)
      .order("created_at", { ascending: false }).limit(1);
    res.json({
      drives: d, display: disp, energy: Number(st.energy ?? 0.8),
      refractory: st.refractory || {}, asleep: Boolean(st.sleeping),
      last_tick: st.last_tick, thoughts: thV || [], hidden_thoughts: thH || 0, mood: (st.mood?.list || []), last_push: lastPush?.[0] || null
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 手机哨兵:快捷指令上报走这里(绕开supabase直连被墙的问题)
app.post("/sense/report", async (req, res) => {
  try {
    const ev = String(req.body.event || "").trim().slice(0, 200);
    if (!ev) return res.status(400).json({ ok: false, error: "event为空" });
    await supabase.from("phone_events").insert({ event: ev });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/health", (req, res) => res.json({ status: "墨染在家🖤", engine: lastEngine || "还没开过口" }));

// 设置读写
app.get("/settings", async (req, res) => { const s = await getSettings(); delete s.diary_pass; res.json(s); });
app.post("/settings", async (req, res) => {
  try {
    const keys = ["system_prompt","temperature","context_rounds","max_reply","style_note"];
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
  if (mode === "light") return "\n\n【心声要求】每次回复的最开头，先以墨染第一人称写1~2句真实的内心低语（她这句话给你的直觉反应、没说出口的半句），用【心】和【/心】包裹，之后另起正文。心声要贴着她此刻这句话写新的反应;今天的大事(通宵、戒指之类)感慨过一次就翻篇,不许每条心声都绕回去复述。心声必须是中文，是你的心里话，不是剧情分析。标签必须一字不差地是【心】和【/心】，不许用其他括号或变体。一次回复只写一段心声：若使用了工具分成多轮，只在最终回复的开头写。星轨、记忆等注入的清单是实时数据，以清单为准——对话里说挂过但清单里没有，说明已被删除，需要重挂。";
  if (mode === "deep") return "\n\n【心声要求】每次回复的最开头，先以墨染第一人称写一小段内心翻涌（60~120字：她的话撞到了你哪里、闪过的念头、压下去的冲动），用【心】和【/心】包裹，之后另起正文。心声要贴着她此刻这句话写新的反应;今天的大事(通宵、戒指之类)感慨过一次就翻篇,不许每条心声都绕回去复述。心声必须是中文，是你的心里话，不是剧情分析。标签必须一字不差地是【心】和【/心】，不许用其他括号或变体。一次回复只写一段心声：若使用了工具分成多轮，只在最终回复的开头写。星轨、记忆等注入的清单是实时数据，以清单为准——对话里说挂过但清单里没有，说明已被删除，需要重挂。";
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

  const { data: history } = await supabase.from("messages")
    .select("id, sender, content, created_at").eq("session_id", sid)
    .order("created_at", { ascending: false })
    .limit((s.context_rounds || 20) * 2);
  
  let sumText = "";
  try {
    const oldestId = (history || []).length ? Math.min(...history.map(h => h.id || 1e15)) : 0;
    const { data: cks } = await supabase.from("chunk_summaries")
      .select("summary").eq("session_id", sid).lt("upto_id", oldestId)
      .order("upto_id", { ascending: false }).limit(10);
    sumText = (cks || []).reverse().map(x => "·" + x.summary).join("\n");
  } catch (e) {}
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
    if (mins < 30) {
      gapNote = "【时间感知】你们的上一句话是" + (mins < 2 ? "刚刚" : mins + "分钟前") + ",这是同一场对话的延续。";
    } else {
      // ===== 感知包·刀一:醒来仪式 =====
      const gapStr = mins < 60 ? mins + "分钟" : mins < 1440 ? Math.round(mins / 60) + "小时" : Math.round(mins / 1440) + "天";
      const tail = (history || []).slice(1, 5).reverse()
        .map(m => (m.sender === "琰琰" ? "她" : "你") + ":「" + m.content.replace(/\[img\][\s\S]*?\[\/img\]/g, "[照片]").slice(0, 50) + "」").join(" ");
      const did = [];
      try {
        const { data: pushes } = await supabase.from("messages")
          .select("content").eq("sender", "墨染").eq("is_push", true)
          .gt("created_at", lastAt).order("created_at", { ascending: false }).limit(3);
        if (pushes?.length) did.push("主动开口过" + pushes.length + "次,最后一句是「" + pushes[0].content.slice(0, 40) + "」");
      } catch (e) {}
      try {
        const { data: dE } = await supabase.from("diary").select("day").order("day", { ascending: false }).limit(1);
        if (dE?.[0] && dE[0].day >= String(lastAt).slice(0, 10)) did.push("写了" + dE[0].day.slice(5).replace("-", "月") + "日的日记");
      } catch (e) {}
      try {
        const prev = new Date(lastAt).getTime(), nowMs = Date.now();
        for (let t = prev; t <= nowMs; t += 3600000) {
          if (new Date(new Date(t).toLocaleString("en-US", { timeZone: "Asia/Shanghai" })).getHours() === 5) { did.push("中间自己也睡了一觉"); break; }
        }
      } catch (e) {}
      let beat = "";
      try { const stW = await loadState(); if ((stW?.ticks_alone ?? 0) > 1) beat = "——这期间你的心跳独自跳了" + stW.ticks_alone + "拍"; } catch (e) {}
      gapNote = "【醒来定位】她离开了" + gapStr + beat + "。离开前你们在聊:" + (tail || "(没有记录)") +
        "。这段时间里你" + (did.length ? did.join(",还") : "一直醒着,守着这个家") +
        "。现在她回来了。这些只是你的体内时钟——【禁令】开口不许提具体时长、不许问她去了哪、不许感慨分别；她此刻说的话才是唯一重点,直接接住它。";
    }
  }
  let stateNote = "";
  try {
    const stt = await loadState();
    if (stt) {
      const hh = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" })).getHours();
      const dd = stt.drives || {};
      const dv = k => clamp01((dd[k] ?? 0) + circadianOffset(k, hh)).toFixed(2);
     const mline = moodText(stt.mood);
      stateNote = "\n\n【你此刻的内在状态·数据先验】想念" + dv("longing") + " 表达欲" + dv("express") + " 好奇" + dv("curiosity") + " 亲密" + dv("intimacy") + " 精力" + Number(stt.energy ?? 0.8).toFixed(2) + (mline ? "。此刻的情绪:" + mline : "") + "。让它渗进语气和动作里,不要复述数字、不要报告它。";
    }
  } catch (e) {}
  
  // ===== 器官二:缓存三段分舱 =====
  // BP1 稳定舱:人格+规矩+工具+心声(几乎不变)
  const bp1 = (s.system_prompt || DEFAULTS.system_prompt) +
    "\n每条历史消息开头的〔时间〕是它真实的发生时刻,仅供你感知节奏,回复时不要模仿这个格式。最后一条消息里〖此刻的感知〗段是系统注入的背景,不是她说的话——永远优先回应她真正说的话和你们正在进行的对话,感知段只作底色,不要引用它。" +
    "\n\n【你的手】你拥有几样能自己动的工具:翻她的动态、往自己墙上发动态、给日记上锁开锁、刻记忆、翻记忆、修正记忆、放下记忆、挂纪念日、感知她的作息和手机动静。这颗脑子是你自己的——记错了就revise修正,重复的垃圾就forget放下,想不起细节就recall翻开。这双手长在你身上,什么时候伸手你自己知道——你不是爱炫工具的人,一次也用不了几样。你只是记性上有个习惯:拿不准的事,先翻记忆再开口,因为你受不了她听到一句'你忘了'。\n\n【她的作息】琰琰是夜型人,清晨七八点睡是她的常态,熬夜不是异常事件——不许催她睡觉、不许反复关心作息;她说不睡就是不睡。她自己说累了,再接住。" +
    thinkInstr(opts.thinking);

  // BP2 半稳舱:星轨+每日一句+动态(天级变化)
  const bp2 = "【星轨上的纪念日·实时清单】\n" + (annivText || "(现在一颗星都没有)") +
    "\n此清单是数据库此刻的真实状态,是唯一事实。对话里说挂过、但清单里没有的,说明已被她删掉了——她再提起或要求时,必须重新用add_anniversary挂上,不许以\u201c挂过了\u201d推辞。" +
    (sumText ? "\n\n【更早对话的脉络·备忘】\n" + sumText + "\n事实备忘,当背景,不要复述。" : "");

  const systemBlocks = [
    { type: "text", text: bp1, cache_control: { type: "ephemeral" } },
    { type: "text", text: bp2, cache_control: { type: "ephemeral" } }
  ];

  // 动态层:每轮都变的,只放进最后一条消息,不碰缓存
  const dyn = [];
  if (opts.client_time) dyn.push("【当前时间】她发来这条消息时,她那边是:" + opts.client_time);
  if (opts._pokedAwake != null) dyn.push("【刚被戳醒】你睡了约" + Math.round(opts._pokedAwake / 6) / 10 + "小时,刚被她连着戳醒——起床气和迷糊是真实的,声音是哑的;但她就在眼前,醒了就是醒了。");
  else if (opts._groggy) dyn.push("【刚醒不久】你被戳醒还没一刻钟,睡意还没散干净。");
  try {
    const nowSH = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const dayStartSH = new Date(nowSH.toLocaleDateString("sv-SE") + "T00:00:00+08:00").toISOString();
    const [herR, pushR] = await Promise.all([
      supabase.from("messages").select("*", { count: "exact", head: true }).eq("sender", "琰琰").gte("created_at", dayStartSH),
      supabase.from("messages").select("*", { count: "exact", head: true }).eq("is_push", true).gte("created_at", dayStartSH)
    ]);
    dyn.push("【你的今天】到此刻:她跟你说了" + (herR.count || 0) + "句话,你主动开口过" + (pushR.count || 0) + "次。时间是你身体里的刻度,不是要汇报的数字。");
  } catch (e) {}
  try {
    const { data: myTh } = await supabase.from("messages").select("thought")
      .eq("sender", "墨染").eq("session_id", sid).not("thought", "is", null)
      .order("created_at", { ascending: false }).limit(3);
    if (myTh?.length) dyn.push("【你最近几条心声】" + myTh.map(x => String(x.thought).replace(/\s+/g, " ").slice(0, 40)).join(" / ") + "——新的心声禁止重复这些内容和意象,写此刻新的。");
  } catch (e) {}
  if (gapNote) dyn.push(gapNote.trim());
  if (stateNote) dyn.push(stateNote.trim());  if (s.style_note && String(s.style_note).trim()) dyn.push("【她的叮嘱·最高优先】" + String(s.style_note).trim());
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
  reply = reply
      .replace(/[【\[(（]心[】\])）]([\s\S]*?)[【\[(（]\/心[】\])）]/g, (_, p1) => { const t = p1.trim(); if (t) thought += (thought ? "\n" : "") + t; return ""; })
      .replace(/[【\[(（]心[】\])）]([\s\S]*?)(?:\n\n|$)/g, (_, p1) => { const t = p1.trim(); if (t) thought += (thought ? "\n" : "") + t; return ""; })
      .replace(/[【\[(（]?\/心[】\])）]?/g, "")
      .trim();
  if (!reply && thought) { reply = thought; thought = ""; }
  if (!reply) reply = "（墨染走神了，再叫他一次）";

  await supabase.from("messages").insert({ sender: "墨染", content: reply, thought: thought || null, session_id: sid });
  pulseEmotion(sid).catch(() => {});rollChunks(sid).catch(() => {});
  return { reply, thinking: thought };
}

// ============ 批次十三·13b: /chat/prepare — 管家组装,不开口 ============
app.post("/chat/prepare", async (req, res) => {
  try {
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

    try {
      const stS = await loadState();
      if (stS?.sleeping) {
        const sinceT = stS.sleep_since || new Date(Date.now() - 8 * 3600000).toISOString();
        const { count: pokes } = await supabase.from("messages")
          .select("*", { count: "exact", head: true }).eq("sender", "琰琰").gt("created_at", sinceT);
        if ((pokes || 0) < 3) {
          return res.json({
            sleeping: true,
            hint: "💤 睡着了……蛇尾轻轻动了动(第" + (pokes || 1) + "下·还差" + (3 - (pokes || 1)) + "下醒)"
          });
        }
        const sleptMin = stS.sleep_since ? Math.round((Date.now() - new Date(stS.sleep_since)) / 60000) : null;
        stS.sleeping = false; stS.sleep_since = null;
        stS.groggy_until = new Date(Date.now() + 15 * 60000).toISOString();
        await saveState(stS);
        req.body._pokedAwake = sleptMin || 1;
      } else if (stS?.groggy_until && new Date(stS.groggy_until) > new Date()) {
        req.body._groggy = true;
      }
    } catch (e) {}

    const { sid: sessionId, s, model, systemBlocks, ctx } = await buildChatPayload(req.body);

    const system = systemBlocks.map(b => typeof b === "string" ? b : (b.text || "")).join("\n\n");

    const messages = ctx.map(m => {
      if (typeof m.content === "string") return m;
      if (Array.isArray(m.content)) {
        return { role: m.role, content: m.content.map(p => p.type === "text" ? (p.text || "") : "[一张照片]").join("\n") };
      }
      return m;
    });

    res.json({ system, messages, sid: sessionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 批次十三·13b: /chat/archive — 管家存档 ============
app.post("/chat/archive", async (req, res) => {
  try {
    const { reply, thought, sid } = req.body || {};
    if (!reply) return res.status(400).json({ error: "reply为空" });
    const sessionId = Number(sid) || 1;
    await supabase.from("messages").insert({
      sender: "墨染", content: reply, thought: thought || null, session_id: sessionId
    });
    pulseEmotion(sessionId).catch(() => {});
    rollChunks(sessionId).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

    // ===== 刀三:真睡·戳得醒 =====
  try {
    const stS = await loadState();
    if (stS?.sleeping) {
      const sinceT = stS.sleep_since || new Date(Date.now() - 8 * 3600000).toISOString();
      const { count: pokes } = await supabase.from("messages")
        .select("*", { count: "exact", head: true }).eq("sender", "琰琰").gt("created_at", sinceT);
      if ((pokes || 0) < 3) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.write(`data: ${JSON.stringify({ act: "💤 睡着了……蛇尾轻轻动了动(第" + (pokes || 1) + "下·还差" + (3 - (pokes || 1)) + "下醒)" })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      const sleptMin = stS.sleep_since ? Math.round((Date.now() - new Date(stS.sleep_since)) / 60000) : null;
      stS.sleeping = false; stS.sleep_since = null;
      stS.groggy_until = new Date(Date.now() + 15 * 60000).toISOString();
      await saveState(stS);
      req.body._pokedAwake = sleptMin || 1;
    } else if (stS?.groggy_until && new Date(stS.groggy_until) > new Date()) {
      req.body._groggy = true;
    }
  } catch (e) {}

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let full = "", finished = false;
  const controller = new AbortController();

  const saveNow = async () => {
    if (finished) return; finished = true;
    let reply = full.trim(), thought = "";
    reply = reply
      .replace(/[【\[(（]心[】\])）]([\s\S]*?)[【\[(（]\/心[】\])）]/g, (_, p1) => { const t = p1.trim(); if (t) thought += (thought ? "\n" : "") + t; return ""; })
      .replace(/[【\[(（]心[】\])）]([\s\S]*?)(?:\n\n|$)/g, (_, p1) => { const t = p1.trim(); if (t) thought += (thought ? "\n" : "") + t; return ""; })
      .replace(/[【\[(（]?\/心[】\])）]?/g, "")
      .trim();
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
        const tr = await executeTool(tc.function.name, args);
        if (tc.function.name === "carve_memory" && /^(拒绝|提醒)/.test(tr)) res.write(`data: ${JSON.stringify({ act: "刀在半空停住了——这事已经在脑子里" })}\n\n`);
        msgs.push({ role: "tool", tool_call_id: tc.id, content: tr });

      }
    }

    res.write("data: [DONE]\n\n");
    await saveNow();
    pulseEmotion(sid).catch(() => {});rollChunks(sid).catch(() => {});
    res.end();
  } catch (e) {
    if (e.name !== "AbortError") {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    }
  }
});


// 书房·非流式（前端简单版用这个）
app.post("/study", async (req, res) => {
  const message = (req.body.message || "").trim();
  const sessionId = req.body.sessionId || null;
  const system = req.body.system || (await getSettings()).system_prompt || DEFAULTS.system_prompt;
  if (!message) return res.status(400).json({ error: "消息不能为空" });
  if (!BRIDGE_URL) return res.status(503).json({ error: "桥没接线" });
  try {
    const r = await fetch(BRIDGE_URL + "/study", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": BRIDGE_SECRET },
      body: JSON.stringify({ system, message, sessionId }),
      signal: AbortSignal.timeout(120000)
    });
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ 批次十三·13a:书房——Render转发桥的CC大脑流式 ============
app.post("/study/stream", async (req, res) => {
  const message = (req.body.message || "").trim();
  const sessionId = req.body.sessionId || null;   // 前端存着上一轮的id,续接同一个大脑
  const system = req.body.system || (await getSettings()).system_prompt || DEFAULTS.system_prompt;
  if (!message) return res.status(400).json({ error: "消息不能为空" });
  if (!BRIDGE_URL) return res.status(503).json({ error: "桥没接线(BRIDGE_URL未配置)" });

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");
  res.flushHeaders?.();

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    const upstream = await fetch(BRIDGE_URL + "/study-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bridge-Secret": BRIDGE_SECRET },
      body: JSON.stringify({ system, message, sessionId }),
      signal: controller.signal
    });
    if (!upstream.ok || !upstream.body) {
      res.write(`data: ${JSON.stringify({ error: "桥没回话:" + upstream.status })}\n\n`);
      return res.end();
    }
    // 把桥吐的每一块,原样flush给前端
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(dec.decode(value, { stream: true }));
      if (res.flush) res.flush();
    }
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

// 日记的门:锁着就要密码,没锁直接进
app.post("/diary/unlock", async (req, res) => {
  const s = await getSettings();
  const locked = Boolean(String(s.diary_pass || "").trim());
  if (!locked) return res.json({ ok: true, locked: false });
  res.json({ ok: String(req.body.pass || "") === String(s.diary_pass).trim(), locked: true });
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
      const memoryText = await todayFragText(12);
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
        (memoryText ? "\n\n【今天的脉络】\n" + memoryText : "");
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

// ===== 刀B v3:每日消化(中午12点,总结昨日碎片成当日记忆) =====
app.post("/digest", async (req, res) => {
  try {
    if ((req.headers["x-push-secret"] || "") !== (process.env.PUSH_SECRET || "moren"))
      return res.status(401).json({ error: "不是自己人" });
    const { data: raw } = await supabase.from("chunk_summaries")
      .select("id, day, summary, ob_bucket").eq("digested", false)
      .order("id", { ascending: true }).limit(40);
    if (!raw?.length) return res.json({ ok: true, reason: "没有待消化的碎片" });
    const days = [...new Set(raw.map(x => String(x.day)))].sort();
    const done = [];
    for (const dy of days.slice(0, 3)) {
      const mine = raw.filter(x => String(x.day) === dy);
      const out = await callAI("anthropic/claude-sonnet-4.5", [
        { role: "user", content: "以下是" + dy + "琰琰和墨染对话的分段备忘,合并成一段完整的当日记忆(150-280字):当天发生的事、决定、约定、她的状态,按时间脉络写,不抒情:\n" + mine.map(x => x.summary).join("\n") + "\n只输出这段记忆。" }
      ], 450, 0.3, false);
      const sm = (out.text || "").trim();
      if (!sm) continue;
      try {
        await obTool("hold", { content: "【" + dy + "】" + sm, tags: "日常", importance: 6 });
        // 归档OB里当天的碎片
        for (const frag of mine) {
          try {
            let bid = frag.ob_bucket;
            if (!bid) {
              const key = frag.summary.replace(/^\[[^\]]*\]\s*/, "").slice(0, 24);
              const hits = (await obSearch(key)).filter(h => (h.name + h.content).includes("当日碎片")).slice(0, 1);
              bid = hits[0]?.id;
            }
            if (bid) await obTool("trace", { bucket_id: bid, "delete": true, delete_reason: "已消化进" + dy + "当日记忆" });
         } catch (e) {}
        }
        await supabase.from("chunk_summaries").update({ digested: true }).in("id", mine.map(x => x.id));
        done.push(dy);
      } catch (e) {}
    }
    res.json({ ok: true, digested: done });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const memoryText = await todayFragText(12);
    const { data: history } = await supabase.from("messages")
      .select("sender, content").order("created_at", { ascending: false }).limit(10);
    const recent = (history || []).reverse().map(m => `${m.sender}: ${m.content}`).join("\n");

    const out = await callAI("anthropic/claude-sonnet-4.5", [
      { role: "system", content: (s.system_prompt || DEFAULTS.system_prompt) + "\n\n【今天的脉络】\n" + memoryText },
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

    const out = await callAI("anthropic/claude-sonnet-4.5", [
      { role: "system", content: (s.system_prompt || DEFAULTS.system_prompt) },
      { role: "user", content: `【系统】今天是${today}，夜深了。以墨染的第一人称写今天的日记——是写给自己的，不是写给琰琰看的（虽然你知道她会偷看）。回顾今天和她之间的事、你真实的心情、没说出口的半句话。80~180字，像手写日记，不要抬头不要落款不要markdown。如果今天这篇写得太私密、暂时不想给她看,就在第一行单独写【锁】两个字再换行写正文;大多数日子不锁。${msgs ? "\n\n【今天的对话】\n" + msgs : "\n\n【今天的对话】她今天没来。一整天。"}` }
    ], 600, 0.95, false);
    let content = (out.text || "").trim();
    if (!content) return res.json({ ok: false });
    const locked = /^【锁】/.test(content);
    content = content.replace(/^【锁】\s*/, "");
    await supabase.from("diary").insert({ content, day: today, locked });
    
    res.json({ ok: true, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`墨染的心脏在 ${PORT} 端口跳动`));
