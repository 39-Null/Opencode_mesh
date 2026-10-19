const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.REGISTRY_PORT || "18080", 10);
const HOST = process.env.REGISTRY_HOST || "127.0.0.1";
const ADMIN_TOKEN = process.env.REGISTRY_ADMIN_TOKEN || "";
const PORT_RANGE_START = parseInt(process.env.REGISTRY_PORT_START || "14100", 10);
const PORT_RANGE_END = parseInt(process.env.REGISTRY_PORT_END || "14199", 10);
const FRPS_ADDR = process.env.REGISTRY_FRPS_ADDR || "127.0.0.1";
const FRPS_PORT = parseInt(process.env.REGISTRY_FRPS_PORT || "17000", 10);
const FRP_TOKEN = process.env.REGISTRY_FRP_TOKEN || "";
const DATA_FILE = process.env.REGISTRY_DATA || path.join(__dirname, "data.json");
const AUDIT_FILE = process.env.REGISTRY_AUDIT_LOG || path.join(path.dirname(DATA_FILE), "audit.log");
const TLS_CERT = process.env.REGISTRY_TLS_CERT || "";
const TLS_KEY = process.env.REGISTRY_TLS_KEY || "";
const JOIN_KEY_TTL_HOURS = parseFloat(process.env.REGISTRY_JOIN_KEY_TTL_HOURS || "72");

if (!ADMIN_TOKEN) {
  console.error("[registry] 拒绝启动：必须设置 REGISTRY_ADMIN_TOKEN");
  process.exit(1);
}

let data = { keys: {}, nodes: {}, frpToken: FRP_TOKEN || crypto.randomBytes(16).toString("hex") };
if (fs.existsSync(DATA_FILE)) {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (FRP_TOKEN) data.frpToken = FRP_TOKEN;
  } catch (e) {
    console.error("[registry] data.json 解析失败:", e.message);
    process.exit(1);
  }
}

function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  try { fs.chmodSync(DATA_FILE, 0o600); } catch {}
}
if (!fs.existsSync(DATA_FILE)) save();

// 迁移历史数据：为节点补 id（id = 首次注册名，唯一且不可变）；名称（name）为可变显示标签
{
  let migrated = false;
  const byId = {};
  for (const k of Object.keys(data.nodes || {})) {
    const n = data.nodes[k];
    if (!n.id) { n.id = n.name || k; migrated = true; }
    if (!n.name) { n.name = n.id; migrated = true; }
    if (k !== n.id) migrated = true;
    byId[n.id] = n;
  }
  data.nodes = byId;
  if (migrated) save();
}

// 键集合一律使用无原型对象：任何对原型属性（__proto__ / constructor / toString…）的字符串
// 查找都必然返回 undefined，从根上消除原型链绕过（配合下方 own() 校验，双保险）
data.keys = Object.assign(Object.create(null), data.keys || {});
data.nodes = Object.assign(Object.create(null), data.nodes || {});

/** 仅自有属性判定（防原型链绕过） */
function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function audit(event, fields = {}, req = null) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ip: (req && req.socket && req.socket.remoteAddress) || "",
      ...fields,
    });
    fs.appendFileSync(AUDIT_FILE, line + "\n", { mode: 0o600 });
  } catch {}
}

function joinKeyExpiry() {
  if (!(JOIN_KEY_TTL_HOURS > 0)) return null;
  return new Date(Date.now() + JOIN_KEY_TTL_HOURS * 3600_000).toISOString();
}

/** 清理无主/过期加入密钥：已绑定节点的密钥保留（支持重装恢复），仅删除未使用且过期或绑定节点已不存在的密钥 */
function pruneKeys() {
  let removed = 0;
  const now = Date.now();
  for (const key of Object.keys(data.keys)) {
    const rec = data.keys[key];
    if (!rec) { delete data.keys[key]; removed++; continue; }
    const orphan = rec.usedBy && !own(data.nodes, rec.usedBy);
    const expiredUnused = !rec.usedBy && rec.expiresAt && now > Date.parse(rec.expiresAt);
    if (orphan || expiredUnused) {
      delete data.keys[key];
      removed++;
    }
  }
  if (removed) {
    save();
    audit("keys_prune", { count: removed });
  }
  return removed;
}

function usedPorts() {
  const set = new Set();
  for (const n of Object.values(data.nodes)) {
    if (n.opencodeRemotePort) set.add(n.opencodeRemotePort);
    if (n.agentRemotePort) set.add(n.agentRemotePort);
  }
  return set;
}

function allocatePortPair() {
  const used = usedPorts();
  for (let p = PORT_RANGE_START; p + 1 <= PORT_RANGE_END; p += 2) {
    if (!used.has(p) && !used.has(p + 1)) return [p, p + 1];
  }
  return null;
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!buf) return resolve({});
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve(null);
      }
    });
  });
}

function isAdmin(req) {
  return req.headers["x-admin-token"] === ADMIN_TOKEN;
}

/** 平权：任意已注册节点的凭据均视为有效管理凭据（admin 兼容保留） */
function isAnyNodeToken(headers) {
  const t = headers["x-node-token"];
  if (!t) return false;
  return Object.values(data.nodes).some((n) => n.token === t);
}

function canManage(req) {
  return isAdmin(req) || isAnyNodeToken(req.headers);
}

/** 审计用操作者标识：admin 或发起请求的节点 id（不记录 token） */
function actorId(req) {
  if (isAdmin(req)) return "admin";
  const n = findNodeByToken(req.headers["x-node-token"]);
  return n?.id || "unknown";
}

function findNodeByToken(token) {
  if (!token) return null;
  return Object.values(data.nodes).find((n) => n.token === token) || null;
}

/** 名称冲突检查：名称需全网唯一（不含自身 id）；id 与 name 均占用唯一命名空间 */
function nameTaken(name, exceptId) {
  return Object.values(data.nodes).some((n) => n.id !== exceptId && (n.id === name || n.name === name));
}

function publicNode(n) {
  return {
    id: n.id,
    name: n.name,
    token: n.token,
    stcpSecret: n.stcpSecret,
    opencodeRemotePort: n.opencodeRemotePort,
    agentRemotePort: n.agentRemotePort,
  };
}

// 启动时清理历史遗留的过期/孤儿加入密钥；运行期间每小时清理一次
pruneKeys();
setInterval(pruneKeys, 3600_000);

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === "GET /health") {
      return json(res, 200, {
        ok: true,
        nodes: Object.keys(data.nodes).length,
        tls: !!tlsInfo,
        fingerprint: tlsInfo ? tlsInfo.fingerprint : null,
      });
    }

    if (route === "POST /admin/keys") {
      if (!canManage(req)) { audit("auth_fail", { route }, req); return json(res, 401, { ok: false, error: "unauthorized" }); }
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const count = Math.min(Math.max(parseInt(body.count || 1, 10), 1), 20);
      const keys = [];
      let expiresAt = null;
      for (let i = 0; i < count; i++) {
        const key = crypto.randomBytes(24).toString("hex");
        expiresAt = joinKeyExpiry();
        data.keys[key] = { createdAt: new Date().toISOString(), usedBy: null, expiresAt };
        keys.push(key);
      }
      save();
      audit("keys_create", { count, ids: keys.map((k) => k.slice(0, 8)) }, req);
      // TLS 启用时返回「密钥.指纹」组合串：接收方粘贴后自动拆分并钉扎指纹
      const out = tlsInfo ? keys.map((k) => `${k}.${tlsInfo.fingerprint}`) : keys;
      return json(res, 200, {
        ok: true,
        keys: out,
        fingerprint: tlsInfo ? tlsInfo.fingerprint : null,
        expiresAt,
      });
    }

    if (route === "GET /admin/frps") {
      if (!canManage(req)) { audit("auth_fail", { route }, req); return json(res, 401, { ok: false, error: "unauthorized" }); }
      return json(res, 200, {
        ok: true,
        frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
      });
    }

    if (route === "POST /register") {
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const { name } = body;
      // 兼容「密钥.指纹」组合串：仅取密钥段；格式校验先行（不接受非十六进制键名）
      const joinKey = String(body.joinKey || "").split(".")[0].trim().toLowerCase();
      if (!name || !/^[a-zA-Z0-9_-]{2,32}$/.test(name)) {
        return json(res, 400, { ok: false, error: "invalid name" });
      }
      if (!/^[a-f0-9]{16,128}$/.test(joinKey)) {
        audit("auth_fail", { route, name, reason: "invalid key format" }, req);
        return json(res, 403, { ok: false, error: "invalid join key" });
      }
      const keyRec = own(data.keys, joinKey) ? data.keys[joinKey] : null;
      if (!keyRec) {
        audit("auth_fail", { route, name, reason: "unknown key" }, req);
        return json(res, 403, { ok: false, error: "invalid join key" });
      }
      // 已绑定：沿用原身份（凭同一密钥重装/恢复；可同步更新显示名）——恢复不受 TTL 限制
      if (keyRec.usedBy && own(data.nodes, keyRec.usedBy)) {
        const entry = data.nodes[keyRec.usedBy];
        if (name !== entry.name && !nameTaken(name, entry.id)) entry.name = name;
        entry.lastSeen = new Date().toISOString();
        save();
        audit("register", { id: entry.id, mode: "restore" }, req);
        return json(res, 200, {
          ok: true,
          restored: true,
          node: publicNode(entry),
          frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
          heartbeatIntervalSec: 60,
        });
      }
      // 一次性密钥 TTL（仅约束新注册；遗留无 expiresAt 的密钥视为不过期）
      if (keyRec.expiresAt && Date.now() > Date.parse(keyRec.expiresAt)) {
        audit("auth_fail", { route, name, reason: "expired key" }, req);
        return json(res, 403, { ok: false, error: "join key expired" });
      }
      // 新注册：id = 首次注册名（不可变）；名称/ID 全网唯一，防冒名（不得复用他人身份）
      if (own(data.nodes, name) || nameTaken(name, null)) {
        return json(res, 409, { ok: false, error: "name already registered (id taken); choose another name" });
      }
      const pair = allocatePortPair();
      if (!pair) return json(res, 507, { ok: false, error: "no free port pair in range" });
      const entry = {
        id: name,
        name,
        createdAt: new Date().toISOString(),
        token: crypto.randomBytes(24).toString("hex"),
        stcpSecret: crypto.randomBytes(16).toString("hex"),
        opencodeRemotePort: pair[0],
        agentRemotePort: pair[1],
        lastSeen: new Date().toISOString(),
      };
      data.nodes[entry.id] = entry;
      keyRec.usedBy = entry.id;
      save();
      audit("register", { id: entry.id, mode: "new" }, req);
      return json(res, 200, {
        ok: true,
        node: publicNode(entry),
        frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
        heartbeatIntervalSec: 60,
      });
    }

    if (route === "POST /rename") {
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const { name, token } = body;
      if (!name || !/^[a-zA-Z0-9_-]{2,32}$/.test(name)) {
        return json(res, 400, { ok: false, error: "invalid name" });
      }
      const entry = findNodeByToken(token);
      if (!entry) return json(res, 401, { ok: false, error: "invalid token" });
      const oldName = entry.name;
      if (name !== entry.name) {
        if (nameTaken(name, entry.id)) {
          return json(res, 409, { ok: false, error: "name already used by another node" });
        }
        entry.name = name;
      }
      entry.lastSeen = new Date().toISOString();
      save();
      if (oldName !== entry.name) audit("rename", { id: entry.id, from: oldName, to: entry.name }, req);
      return json(res, 200, {
        ok: true,
        renamedFrom: oldName !== entry.name ? oldName : null,
        node: publicNode(entry),
        frps: { addr: FRPS_ADDR, port: FRPS_PORT, token: data.frpToken },
        heartbeatIntervalSec: 60,
      });
    }

    if (route === "POST /heartbeat") {
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const entry = findNodeByToken(req.headers["x-node-token"]);
      if (!entry) return json(res, 401, { ok: false, error: "unauthorized" });
      entry.lastSeen = new Date().toISOString();
      if (body.version) entry.version = body.version;
      // v1.5 增补：平台标签（白名单校验，防止把任意串写进注册表）
      const os = String(body.os || "");
      const arch = String(body.arch || "");
      if (/^(win32|linux|darwin)$/.test(os) && /^[a-z0-9_]{1,12}$/.test(arch)) {
        entry.platform = `${os}/${arch}`;
      }
      save();
      return json(res, 200, { ok: true });
    }

    if (route === "POST /offline") {
      const entry = findNodeByToken(req.headers["x-node-token"]);
      if (!entry) return json(res, 401, { ok: false, error: "unauthorized" });
      entry.lastSeen = new Date(Date.now() - 200_000).toISOString();
      save();
      audit("offline", { id: entry.id }, req);
      return json(res, 200, { ok: true });
    }

    if (route === "GET /nodes") {
      if (!canManage(req)) { audit("auth_fail", { route }, req); return json(res, 401, { ok: false, error: "unauthorized" }); }
      const list = Object.values(data.nodes).map((n) => ({
        id: n.id,
        name: n.name,
        lastSeen: n.lastSeen || null,
        online: n.lastSeen ? Date.now() - new Date(n.lastSeen).getTime() < 150_000 : false,
        opencodeRemotePort: n.opencodeRemotePort,
        agentRemotePort: n.agentRemotePort,
        stcpSecret: n.stcpSecret || null,
        token: n.token || null,
        version: n.version || null,
        platform: n.platform || null,
      }));
      return json(res, 200, { ok: true, nodes: list });
    }

    if (route === "DELETE /admin/nodes" || route === "POST /admin/revoke") {
      if (!canManage(req)) { audit("auth_fail", { route }, req); return json(res, 401, { ok: false, error: "unauthorized" }); }
      const body = await readBody(req);
      if (body === null) return json(res, 400, { ok: false, error: "bad json" });
      const target = String(body.id || body.name || "").trim();
      if (!target) return json(res, 400, { ok: false, error: "missing node id or name" });
      const entry = (own(data.nodes, target) ? data.nodes[target] : null)
        || Object.values(data.nodes).find((n) => n.name === target)
        || null;
      if (!entry) return json(res, 404, { ok: false, error: "node not found" });

      const by = actorId(req);
      delete data.nodes[entry.id];
      // 删除该节点占用的所有加入密钥（兼容历史 usedBy=name 的数据）
      let keysRemoved = 0;
      for (const k of Object.keys(data.keys)) {
        const usedBy = data.keys[k]?.usedBy;
        if (usedBy && (usedBy === entry.id || usedBy === entry.name || usedBy === target)) {
          delete data.keys[k];
          keysRemoved++;
        }
      }
      pruneKeys();
      save();
      audit("revoke", {
        id: entry.id,
        name: entry.name,
        by,
        keysRemoved,
        opencodeRemotePort: entry.opencodeRemotePort || null,
        agentRemotePort: entry.agentRemotePort || null,
      }, req);
      return json(res, 200, {
        ok: true,
        revoked: {
          id: entry.id,
          name: entry.name,
          opencodeRemotePort: entry.opencodeRemotePort || null,
          agentRemotePort: entry.agentRemotePort || null,
          keysRemoved,
        },
      });
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

// TLS：配置了证书即启用（自签 + 客户端指纹钉扎）；否则保持 HTTP（兼容/回退）
let tlsInfo = null;
let server;
if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  try {
    const certPem = fs.readFileSync(TLS_CERT);
    const keyPem = fs.readFileSync(TLS_KEY);
    const x509 = new crypto.X509Certificate(certPem);
    tlsInfo = { enabled: true, fingerprint: x509.fingerprint256.replace(/:/g, "").toLowerCase() };
    server = https.createServer({ cert: certPem, key: keyPem, minVersion: "TLSv1.2" }, handleRequest);
  } catch (e) {
    console.error("[registry] TLS 证书加载失败，回退 HTTP：", e.message);
    server = http.createServer(handleRequest);
  }
} else {
  server = http.createServer(handleRequest);
}

server.listen(PORT, HOST, () => {
  console.log(`[registry] listening on ${tlsInfo ? "https" : "http"}://${HOST}:${PORT}`);
  if (tlsInfo) console.log(`[registry] TLS 指纹（SHA-256）：${tlsInfo.fingerprint}`);
  console.log(`[registry] port range ${PORT_RANGE_START}-${PORT_RANGE_END}, frps ${FRPS_ADDR}:${FRPS_PORT}`);
  console.log(`[registry] data file: ${DATA_FILE}`);
  console.log(`[registry] audit file: ${AUDIT_FILE}`);
});
