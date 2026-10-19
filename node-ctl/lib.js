const fs = require("fs");
const path = require("path");
const http = require("http");
const tls = require("tls");
const crypto = require("crypto");

function loadConfig(explicit) {
  const candidates = [
    explicit,
    process.env.NODECTL_CONFIG,
    path.join(process.cwd(), "nodes.json"),
    path.join(__dirname, "nodes.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
      return { path: p, config: JSON.parse(raw) };
    }
  }
  throw new Error(`找不到配置文件（尝试过：${candidates.join(", ")}）\n可参考 configs/nodes.example.json 创建 nodes.json`);
}

/** 节点解析：支持注册 id（nodes.json 键）或显示名（entry.name） */
function resolveNodeEntry(config, nameOrId) {
  const nodes = config.nodes || {};
  if (nodes[nameOrId]) return { key: nameOrId, node: nodes[nameOrId] };
  const hit = Object.entries(nodes).find(([, v]) => v?.name === nameOrId);
  if (hit) return { key: hit[0], node: hit[1] };
  return null;
}

function getNode(config, name) {
  const hit = resolveNodeEntry(config, name);
  if (!hit) {
    const names = Object.entries(config.nodes || {}).map(([k, v]) => (v?.name && v.name !== k ? `${k}(${v.name})` : k));
    throw new Error(`未配置节点 "${name}"。已配置：${names.length ? names.join(", ") : "（无）"}`);
  }
  if (!hit.node.agentUrl) throw new Error(`节点 "${name}" 缺少 agentUrl`);
  return hit.node;
}

/* ==================== 平权凭据解析（与本机节点共享） ==================== */

function repoRoot() {
  return path.join(__dirname, "..");
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function localNode(repo) {
  const cfg = readJson(path.join(repo, "node-agent", "node.json"));
  const state = readJson(path.join(repo, "node-agent", "data", "state.json"));
  return { hub: cfg?.hub || null, token: state?.token || "" };
}

/** 构建 registry 请求：平权优先本机节点凭据（admin 兼容）；地址回退本机 node.json 的 Hub */
function registryAuth(reg, repo) {
  const local = localNode(repo || repoRoot());
  const address = (reg && reg.address) || local.hub?.address || "";
  const port = (reg && reg.port) || local.hub?.port || 18080;
  const fingerprint = (reg && reg.fingerprint) || local.hub?.fingerprint || "";
  const headers = {};
  if (local.token) headers["X-Node-Token"] = local.token;
  if (reg && reg.adminToken) headers["X-Admin-Token"] = reg.adminToken;
  return { address, port, headers, fingerprint };
}

/** 指纹钉扎 HTTPS 请求：自签证书场景跳过 CA 链校验，但在握手完成后、发送任何数据之前校验 SHA-256 指纹 */
function pinnedRequest({ hostname, port, method = "GET", path: reqPath = "/", headers = {}, body, fingerprint, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const expected = String(fingerprint || "").replace(/:/g, "").toLowerCase();
    let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    const socket = tls.connect({ host: hostname, port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); settle({ status: 0, json: null, text: "timeout" }); });
    socket.once("error", (e) => settle({ status: 0, json: null, text: e.message }));
    socket.once("secureConnect", () => {
      let fp = "";
      try {
        const cert = socket.getPeerCertificate(true);
        if (cert && cert.raw) fp = crypto.createHash("sha256").update(cert.raw).digest("hex");
      } catch {}
      if (!fp || fp !== expected) {
        socket.destroy();
        settle({ status: 0, json: null, text: "certificate fingerprint mismatch（证书指纹不匹配，可能遭遇中间人）" });
        return;
      }
      const req = http.request(
        {
          createConnection: () => socket,
          hostname, port, method, path: reqPath,
          headers: { "Content-Type": "application/json", ...headers },
          timeout: timeoutMs,
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => {
            let json = null;
            try { json = JSON.parse(buf); } catch {}
            settle({ status: res.statusCode, json, text: buf });
          });
        }
      );
      req.on("timeout", () => { req.destroy(); settle({ status: 0, json: null, text: "timeout" }); });
      req.on("error", (e) => settle({ status: 0, json: null, text: e.message }));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

/** registry 请求：配置了指纹走钉扎 HTTPS；否则维持原有 HTTP（未启用 TLS 的旧 Hub 兼容） */
async function registryFetch(a, method, p, body, timeoutMs = 8000) {
  if (a.fingerprint) {
    return pinnedRequest({ hostname: a.address, port: a.port, method, path: p, headers: a.headers, body, fingerprint: a.fingerprint, timeoutMs });
  }
  try {
    const res = await fetch(`http://${a.address}:${a.port}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...a.headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e.message };
  }
}

async function registryNodes(reg) {
  const a = registryAuth(reg);
  if (!a.address) return null;
  const r = await registryFetch(a, "GET", "/nodes", undefined, 5000);
  return r.status === 200 && r.json?.ok ? r.json.nodes : null;
}

async function registryFrps(reg) {
  const a = registryAuth(reg);
  if (!a.address) return null;
  const r = await registryFetch(a, "GET", "/admin/frps", undefined, 5000);
  return r.status === 200 && r.json?.ok ? r.json.frps : null;
}

async function agentCall(nodeCfg, method, endpoint, timeoutMs) {
  const url = nodeCfg.agentUrl.replace(/\/+$/, "") + endpoint;
  try {
    const res = await fetch(url, {
      method,
      headers: { "X-Agent-Token": nodeCfg.agentToken || "" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e.message };
  }
}

async function agentHealth(nodeCfg) {
  const url = nodeCfg.agentUrl.replace(/\/+$/, "") + "/health";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const j = await res.json();
    return { reachable: res.ok, name: j.name, version: j.version };
  } catch {
    return { reachable: false };
  }
}

/* ==================== 共享密码解析（加密存储解封） ==================== */

let _secretStore = null;
function loadSecretStore() {
  if (_secretStore !== null) return _secretStore;
  try {
    _secretStore = require(path.join(repoRoot(), "node-agent", "secret-store.js"));
  } catch {
    _secretStore = false;
  }
  return _secretStore;
}

/** 解析共享密码：fleetPasswordEnc（DPAPI/密钥环）→ 解封；兼容旧明文字段 fleetPassword；回退本机节点密码（统一密码网络自动派生） */
function resolveFleetPassword(config) {
  if (!config) return "";
  if (config.fleetPasswordEnc) {
    const store = loadSecretStore();
    if (!store) throw new Error("无法解封共享密码：缺少 node-agent/secret-store.js（请更新仓库）");
    try {
      return store.unseal(config.fleetPasswordEnc);
    } catch (e) {
      throw new Error("共享密码解密失败：" + (e.message || e) + "（换机/换用户后请重新设置共享密码）");
    }
  }
  if (config.fleetPassword) return config.fleetPassword;
  const nodeCfg = readJson(path.join(repoRoot(), "node-agent", "node.json"));
  const oc = nodeCfg?.opencode || {};
  try {
    const store = loadSecretStore();
    if (oc.passwordEnc && store) return store.unseal(oc.passwordEnc);
    if (oc.password) return oc.password;
  } catch {}
  return "";
}

/* ==================== opencode-mesh 协议 v1（信封 / 回执 / 派发） ==================== */

function saveConfigFile(filePath, cfg) {
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function newTaskId(prefix = "t") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
}

/** 本机平台标签（v1.5：env 头用） */
function platformTag() {
  return `${process.platform}/${process.arch}`;
}

function wrapEnvelope({ from, task, mode = "one-shot", body, env }) {
  const lines = [
    "[opencode-mesh v1]",
    `from: ${from}`,
    `task: ${task}`,
    `mode: ${mode}`,
    "reply: result-block",
  ];
  if (env) lines.push(`env: ${env}`);
  lines.push("---", body);
  return lines.join("\n");
}

function parseResultBlock(text) {
  const s = String(text || "");
  let body = null;
  // 优先新标记；兼容旧标记 [aoi-mesh-result v1]（历史名称，含混用开闭标签）
  const strict = /\[(?:opencode|aoi)-mesh-result v1\]([\s\S]*?)\[\/(?:opencode|aoi)-mesh-result\]/i.exec(s);
  if (strict) {
    body = strict[1];
  } else {
    // 宽松回退：容忍接收端漏写标签（未加载 instructions）但给出 status 行的情况
    const loose = /(?:^|\n)\s*status\s*:\s*(done|partial|failed)\s*(?:\n([\s\S]*))?/i.exec(s);
    if (loose) body = `status: ${loose[1]}\n${loose[2] || ""}`;
  }
  if (!body) return null;
  const fields = {};
  for (const line of body.split(/\r?\n/)) {
    const mm = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
    if (mm) fields[mm[1].toLowerCase()] = mm[2].trim();
  }
  if (fields.status && !fields.summary) {
    const rest = body
      .replace(/^[\s\S]*?status\s*:\s*\w+\s*/i, "")
      .replace(/^-{2,}\s*$/gm, "")
      .replace(/^result-block\s*$/gim, "")
      .trim();
    if (rest) fields.summary = rest.slice(0, 800);
  }
  return fields;
}

async function opencodeApi(nodeCfg, method, endpoint, body, timeoutMs = 30000) {
  const base = (nodeCfg.opencodeUrl || "").replace(/\/+$/, "");
  if (!base) return { status: 0, json: null, text: "缺少 opencodeUrl" };
  const auth = "Basic " + Buffer.from(`opencode:${nodeCfg.opencodePassword || ""}`).toString("base64");
  try {
    const res = await fetch(base + endpoint, {
      method,
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: e.message };
  }
}

/* ==================== v1.5 增补：会话结转（digest）与会话管理 ==================== */

/** 解析 [opencode-mesh-digest v1] 块（宽松：facts/pending/refs 支持多行续写；无块返回 null） */
function parseDigestBlock(text) {
  const s = String(text || "");
  const strict = /\[opencode-mesh-digest v1\]([\s\S]*?)\[\/opencode-mesh-digest\]/i.exec(s);
  if (!strict) return null;
  const out = { task: "", gen: 1, facts: [], pending: "", refs: "" };
  let section = null;
  for (const raw of strict[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(task|gen|facts|pending|refs)\s*[:：]\s*(.*)$/i.exec(line);
    if (m) {
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      if (k === "task") out.task = v;
      else if (k === "gen") out.gen = parseInt(v, 10) || 1;
      else if (k === "facts") { section = "facts"; if (v && !/^</.test(v)) out.facts.push(v.replace(/^[-•]\s*/, "")); }
      else if (k === "pending") { section = "pending"; if (!/^none$/i.test(v)) out.pending = v; }
      else if (k === "refs") { section = "refs"; if (!/^none$/i.test(v)) out.refs = v; }
      continue;
    }
    if (section === "facts") out.facts.push(line.replace(/^[-•]\s*/, ""));
    else if (section === "pending") out.pending = out.pending ? `${out.pending} ${line}` : line;
    else if (section === "refs") out.refs = out.refs ? `${out.refs} ${line}` : line;
  }
  if (!out.facts.length && !out.pending && !out.refs) return null;
  return out;
}

const _providersCache = new Map(); // opencodeUrl -> { at, data }（模型上下文上限缓存，30 分钟）

/** 读取目标 opencode 的 provider/模型清单（带缓存；缓存命中失败时回退缓存） */
async function fetchProviders(nodeCfg, { force = false } = {}) {
  const base = (nodeCfg.opencodeUrl || "").replace(/\/+$/, "");
  const hit = _providersCache.get(base);
  if (!force && hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  const r = await opencodeApi(nodeCfg, "GET", "/config/providers", undefined, 8000);
  if (r.status !== 200 || !r.json) return hit ? hit.data : null;
  _providersCache.set(base, { at: Date.now(), data: r.json });
  return r.json;
}

/** 会话上下文占用：末条 assistant 的 tokens.total（当前占用）÷ 模型 limit.context（上限） */
async function sessionUsage(nodeCfg, sessionId) {
  if (!sessionId) return { ok: true, sessionId: null, used: 0, limit: 0, percent: null };
  const r = await opencodeApi(nodeCfg, "GET", `/session/${sessionId}/message?limit=2`, undefined, 10000);
  if (r.status === 404) {
    return { ok: true, sessionId, stale: true, used: 0, limit: 0, percent: null };
  }
  if (r.status !== 200 || !Array.isArray(r.json)) {
    return { ok: false, sessionId, error: `读取会话消息失败（HTTP ${r.status}${r.text ? ` ${String(r.text).slice(0, 80)}` : ""}）` };
  }
  const assistants = r.json.filter((m) => m?.info?.role === "assistant" && m.info.tokens);
  const last = assistants[assistants.length - 1];
  if (!last) return { ok: true, sessionId, used: 0, limit: 0, percent: null };
  const used = Number(last.info.tokens.total) || 0;
  const providerID = last.info.providerID || "";
  const modelID = last.info.modelID || "";
  let limit = 0;
  try {
    const provs = await fetchProviders(nodeCfg);
    const p = (provs?.providers || []).find((x) => x.id === providerID) || null;
    const mdl = p?.models?.[modelID] || null;
    if (mdl?.limit?.context) limit = Number(mdl.limit.context) || 0;
  } catch {}
  const percent = limit > 0 ? Math.round((used / limit) * 100) : null;
  return { ok: true, sessionId, used, limit, percent, providerID, modelID };
}

/** 压缩会话：digest（可带前代合并）→ 新会话 resume 接续 → 换绑；失败保持原样（保守回退） */
async function compactSession(configPath, config, nodeName, opts = {}) {
  const hit = resolveNodeEntry(config, nodeName);
  if (!hit?.node?.opencodeUrl) throw new Error(`节点 "${nodeName}" 缺少 opencodeUrl（先在 App「主控」页同步节点）`);
  const nodeKey = hit.key;
  const node = hit.node;
  const nodeCfg = { ...node, opencodePassword: resolveFleetPassword(config) };
  if (!nodeCfg.opencodePassword) throw new Error("缺少统一密码（请在 App「设置」页配置本机节点密码，或从其他控制端导入配置）");
  if (!node.sessionId) return { ok: false, error: "该节点尚无绑定会话（先派发一次任务）" };

  const probe = await opencodeApi(nodeCfg, "GET", `/session/${node.sessionId}`, undefined, 8000);
  if (probe.status !== 200) return { ok: false, error: "绑定会话不存在（可能已被清空），请先派发任务重建" };

  const from = opts.from || "master";
  const task = newTaskId("digest");
  const prev = node.digest && node.digest.text ? node.digest : null;
  const gen = (prev?.gen || 0) + 1;

  let body = [
    "本任务：生成本会话的上下文结转摘要（用于接续到新会话）。",
    "严格只输出下列块（不要任何其他文字）。facts 每行一条、抽取式逐字保留关键路径/命令/结论/约束，按重要性排序：",
    "[opencode-mesh-digest v1]",
    `task: ${task}`,
    `gen: ${gen}`,
    "facts: <事实行>",
    "pending: <未完成事项或 none>",
    "refs: <产物/日志路径或 none>",
    "[/opencode-mesh-digest]",
  ].join("\n");
  if (prev) {
    body += `\n\n上一代摘要（合并规则：保留仍有效事实、删除过期、追加新增；只输出合并后的块）：\n${prev.text}`;
  }

  const env = `s=${platformTag()} r=${node.platform || "?"}`;
  const req = wrapEnvelope({ from, task, mode: "one-shot", body, env });
  const r1 = await opencodeApi(nodeCfg, "POST", `/session/${node.sessionId}/message`, { parts: [{ type: "text", text: req }] }, (opts.timeoutSec || 300) * 1000);
  if (r1.status !== 200 || !r1.json) return { ok: false, error: `digest 请求失败（HTTP ${r1.status}）` };
  const text1 = (r1.json.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n");
  const digest = parseDigestBlock(text1);
  if (!digest) return { ok: false, error: "digest 块不合规，已放弃轮换（会话保持原样）" };

  const created = await opencodeApi(nodeCfg, "POST", "/session", { title: `Aoi mesh ${from}` }, 15000);
  if (created.status !== 200 || !created.json?.id) return { ok: false, error: `创建新会话失败（HTTP ${created.status}）` };
  const newSessionId = created.json.id;

  const digestText = [
    "[opencode-mesh-digest v1]",
    `task: ${task}`,
    `gen: ${digest.gen}`,
    "facts:",
    ...digest.facts.map((f) => `- ${f}`),
    `pending: ${digest.pending || "none"}`,
    `refs: ${digest.refs || "none"}`,
    "[/opencode-mesh-digest]",
  ].join("\n");
  const receipts = (node.history || [])
    .slice(0, 2)
    .map((h) => `task: ${h.task} → ${h.status}\nsummary: ${h.summary || ""}`)
    .join("\n---\n");
  const resumeBody = [
    `上下文结转（mode: resume）：以下为上一会话的结转摘要（gen ${digest.gen}）与近窗回执。`,
    "仅回执确认加载（status: done，summary: 已加载结转），不要执行其它动作。",
    digestText,
    receipts ? `近窗回执：\n${receipts}` : "",
  ].filter(Boolean).join("\n");
  const resumeReq = wrapEnvelope({ from, task: newTaskId("resume"), mode: "resume", body: resumeBody, env });
  const r2 = await opencodeApi(nodeCfg, "POST", `/session/${newSessionId}/message`, { parts: [{ type: "text", text: resumeReq }] }, (opts.timeoutSec || 300) * 1000);
  const text2 = r2.status === 200 && r2.json ? (r2.json.parts || []).filter((p) => p.type === "text").map((p) => p.text).join("\n") : "";
  const ack = parseResultBlock(text2);

  const usageInfo = r2.json?.info?.tokens?.total
    ? { used: Number(r2.json.info.tokens.total), model: r2.json.info.modelID || node.usage?.model || "", at: new Date().toISOString() }
    : node.usage || null;
  const prevSessions = [node.sessionId, ...(node.prevSessions || [])].filter(Boolean).slice(0, 5);
  config.nodes[nodeKey] = {
    ...node,
    sessionId: newSessionId,
    prevSessions,
    digest: { gen: digest.gen, text: digestText.slice(0, 2000), at: new Date().toISOString() },
    ...(usageInfo ? { usage: usageInfo } : {}),
  };
  if (configPath) {
    try { saveConfigFile(configPath, config); } catch {}
  }
  return {
    ok: true,
    oldSessionId: node.sessionId,
    newSessionId,
    gen: digest.gen,
    facts: digest.facts.length,
    pending: digest.pending || "none",
    refs: digest.refs || "none",
    ack: ack?.status || "no-result-block",
    usage: usageInfo,
  };
}

/** 清空会话：目标可达时才删除远端会话并清除绑定；目标离线/拒绝时保持本地绑定不变 */
async function clearSession(configPath, config, nodeName) {
  const hit = resolveNodeEntry(config, nodeName);
  if (!hit?.node) throw new Error(`未配置节点 "${nodeName}"`);
  const nodeKey = hit.key;
  const node = hit.node;

  // 没有绑定会话：只清理可能残留的占用缓存与 digest，不需要访问目标
  if (!node.sessionId) {
    const next = { ...node };
    delete next.digest;
    delete next.usage;
    config.nodes[nodeKey] = next;
    if (configPath) {
      try { saveConfigFile(configPath, config); } catch {}
    }
    return { ok: true, deletedSessionId: null, noBinding: true };
  }

  const nodeCfg = { ...node, opencodePassword: resolveFleetPassword(config) };
  if (!nodeCfg.opencodePassword) {
    return { ok: false, error: "缺少网络统一密码，无法确认目标节点会话状态；已拒绝清空，本机绑定保持不变" };
  }

  const r = await opencodeApi(nodeCfg, "DELETE", `/session/${node.sessionId}`, undefined, 15000);
  if (r.status === 0) {
    return {
      ok: false,
      error: `目标节点不可达，已拒绝清空：${r.text || "连接失败"}；本机绑定与占用缓存保持不变`,
    };
  }
  if (r.status !== 200 && r.status !== 404) {
    return {
      ok: false,
      error: `目标节点拒绝删除会话（HTTP ${r.status}${r.text ? ` ${String(r.text).slice(0, 80)}` : ""}）；本机绑定保持不变`,
    };
  }

  const deleted = r.status === 200 ? node.sessionId : null;
  const next = { ...node };
  delete next.sessionId;
  delete next.digest;
  delete next.usage;
  config.nodes[nodeKey] = next;
  if (configPath) {
    try { saveConfigFile(configPath, config); } catch {}
  }
  return { ok: true, deletedSessionId: deleted, alreadyGone: r.status === 404 };
}

/** 按 opencode-mesh 协议派发任务（复用节点会话；解析回执块） */
async function dispatchToNode(configPath, config, nodeName, body, opts = {}) {
  const hit = resolveNodeEntry(config, nodeName);
  if (!hit?.node?.opencodeUrl) throw new Error(`节点 "${nodeName}" 缺少 opencodeUrl（先在 App「主控」页同步节点）`);
  const nodeKey = hit.key;
  let node = hit.node;
  const nodeCfg = { ...node, opencodePassword: resolveFleetPassword(config) };
  if (!nodeCfg.opencodePassword) throw new Error("缺少统一密码（请在 App「设置」页配置本机节点密码，或从其他控制端导入配置）");

  const from = opts.from || "master";

  // v1.5：目标平台未知时向注册表要一次并落盘（用于 env 头；失败不阻塞）
  if (!node.platform) {
    try {
      const regs = await registryNodes(config.registry);
      const reg = (regs || []).find((n) => (n.id || n.name) === nodeKey || n.name === node.name);
      if (reg?.platform) {
        node = { ...node, platform: reg.platform };
        if (configPath) {
          config.nodes[nodeKey] = { ...node };
          try { saveConfigFile(configPath, config); } catch {}
        }
      }
    } catch {}
  }

  // v1.5：派发前自动压缩（开关在 App 设置页；占用 ≥80% 时先结转压缩再派发）
  if (config.autoCompact && !opts.newSession && node.sessionId) {
    try {
      const u = await sessionUsage(nodeCfg, node.sessionId);
      if (u.ok && u.limit > 0 && u.used / u.limit >= 0.8) {
        const c = await compactSession(configPath, config, nodeName, { from });
        if (c.ok) node = config.nodes[nodeKey] || node;
      }
    } catch {}
  }

  const task = opts.task || newTaskId("t");
  const mode = opts.mode || "one-shot";

  let sessionId = opts.newSession ? null : node.sessionId || null;
  if (sessionId) {
    const probe = await opencodeApi(nodeCfg, "GET", `/session/${sessionId}`, undefined, 8000);
    if (probe.status !== 200) sessionId = null;
  }
  if (!sessionId) {
    const created = await opencodeApi(nodeCfg, "POST", "/session", { title: `Aoi mesh ${from}` }, 15000);
    if (created.status !== 200 || !created.json?.id) {
      throw new Error(`创建会话失败: HTTP ${created.status} ${String(created.text).slice(0, 120)}`);
    }
    sessionId = created.json.id;
  }

  const env = `s=${platformTag()} r=${node.platform || "?"}`;
  const envelope = wrapEnvelope({ from, task, mode, body, env });
  const timeoutMs = (opts.timeoutSec || 300) * 1000;
  const res = await opencodeApi(nodeCfg, "POST", `/session/${sessionId}/message`, {
    parts: [{ type: "text", text: envelope }],
  }, timeoutMs);
  if (res.status !== 200 || !res.json) {
    throw new Error(`派发失败: HTTP ${res.status} ${String(res.text).slice(0, 160)}`);
  }

  const texts = (res.json.parts || [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  const parsed = parseResultBlock(texts);

  if (configPath) {
    // v1.5：派发响应自带 tokens.total（零额外流量）→ 记录占用；回执入近窗历史（≤2 条）
    const usageInfo = res.json?.info?.tokens?.total
      ? { used: Number(res.json.info.tokens.total), model: res.json.info.modelID || node.usage?.model || "", at: new Date().toISOString() }
      : node.usage || null;
    const history = [
      { task, status: parsed?.status || "unknown", summary: String(parsed?.summary || "").slice(0, 300), at: new Date().toISOString() },
      ...(node.history || []),
    ].slice(0, 2);
    config.nodes[nodeKey] = { ...node, sessionId, history, ...(usageInfo ? { usage: usageInfo } : {}) };
    try {
      saveConfigFile(configPath, config);
    } catch {}
  }

  return {
    ok: true,
    task,
    sessionId,
    status: parsed?.status || (texts ? "no-result-block" : "empty"),
    summary: parsed?.summary || texts.slice(0, 800),
    artifacts: parsed?.artifacts || "",
    raw: texts,
  };
}

module.exports = {
  loadConfig,
  getNode,
  resolveNodeEntry,
  agentCall,
  agentHealth,
  registryNodes,
  registryFrps,
  registryAuth,
  registryFetch,
  pinnedRequest,
  resolveFleetPassword,
  saveConfigFile,
  newTaskId,
  wrapEnvelope,
  parseResultBlock,
  parseDigestBlock,
  opencodeApi,
  platformTag,
  fetchProviders,
  sessionUsage,
  compactSession,
  clearSession,
  dispatchToNode,
};

