#!/usr/bin/env node
/**
 * opencode-mesh node agent
 * 常驻进程：注册入网、维护 frp 隧道、管理本机 opencode 生命周期、提供受控 API。
 * 仅生命周期命令，不做任意命令执行。
 */
const http = require("http");
const https = require("https");
const tls = require("tls");
const crypto = require("crypto");
const { spawn, exec } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const secretStore = require("./secret-store");

const ROOT = __dirname;
const CONFIG_FILE = process.env.AGENT_CONFIG || path.join(ROOT, "node.json");
const DATA_DIR = path.join(ROOT, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const FRPC_CONFIG = path.join(DATA_DIR, "frpc.toml");
const AGENT_LOG = path.join(DATA_DIR, "agent.log");

const VERSION = "0.2.0";

function log(...args) {
  const raw = args.join(" ").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
  if (!raw) return;
  const line = `[${new Date().toISOString()}] ${raw}`;
  console.log(line);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(AGENT_LOG, line + "\n");
  } catch {}
}

/** 读取并解析配置文件（不解密） */
function loadRawConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, ""));
}

/** 解析 opencode 密码：优先 passwordEnc（加密存储）→ 解封到内存；解封失败标记 _pwError（拒绝自动启动 opencode） */
function resolveOpencodeSecrets(cfg) {
  if (!cfg || !cfg.opencode) return cfg;
  if (cfg.opencode.passwordEnc) {
    try {
      cfg.opencode.password = secretStore.unseal(cfg.opencode.passwordEnc);
      delete cfg.opencode._pwError;
    } catch (e) {
      cfg.opencode.password = "";
      cfg.opencode._pwError = `凭据解密失败（${e.message || e}）`;
    }
  }
  return cfg;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`缺少配置文件：${CONFIG_FILE}`);
    console.error("可参考 configs/node.example.json 创建");
    process.exit(1);
  }
  try {
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    return resolveOpencodeSecrets(loadRawConfig());
  } catch (e) {
    console.error(`配置文件解析失败（${CONFIG_FILE}）：${e.message}`);
    process.exit(1);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  try { fs.chmodSync(STATE_FILE, 0o600); } catch {}
}

/** 指纹钉扎 HTTPS 请求：自签证书场景跳过 CA 链校验，但在握手完成后、发送任何数据之前校验 SHA-256 指纹 */
function pinnedRequest({ hostname, port, method = "GET", path: reqPath = "/", headers = {}, body, fingerprint, timeoutMs = 10000 }) {
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

function httpJson(method, urlStr, body, headers = {}, timeoutMs = 10000, fingerprint = "") {
  const url = new URL(urlStr);
  if (fingerprint && url.protocol === "https:") {
    return pinnedRequest({ hostname: url.hostname, port: url.port || 443, method, path: url.pathname + url.search, headers, body, fingerprint, timeoutMs });
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(buf);
          } catch {}
          resolve({ status: res.statusCode, json, text: buf });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: null, text: "timeout" });
    });
    req.on("error", (e) => resolve({ status: 0, json: null, text: e.message }));
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** 恒时比较（防时序侧信道）：长度不同或空值直接拒绝 */
function tokenEquals(provided, expected) {
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(String(expected || ""));
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 读取请求体（JSON，1MB 上限） */
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

function execCmd(command, timeoutMs = 15000) {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve(String(stdout || "") + String(stderr || ""));
    });
  });
}

async function findPidByPort(port) {
  if (process.platform === "win32") {
    const out = await execCmd("netstat -ano -p tcp");
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[1].endsWith(`:${port}`) && /LISTENING/i.test(cols[3])) {
        const pid = parseInt(cols[4], 10);
        if (Number.isInteger(pid)) return pid;
      }
    }
    return null;
  }
  const out = await execCmd(`ss -ltnp 2>/dev/null | grep ":${port} "`);
  const m = out.match(/pid=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function killPid(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    await execCmd(`taskkill /pid ${pid} /t /f`);
  } else {
    await execCmd(`kill -TERM ${pid}`);
    await new Promise((r) => setTimeout(r, 1500));
    await execCmd(`kill -KILL ${pid} 2>/dev/null`);
  }
  return true;
}

async function opencodeHealthy(port, password) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/global/health",
        method: "GET",
        headers: password
          ? { Authorization: "Basic " + Buffer.from(`opencode:${password}`).toString("base64") }
          : {},
        timeout: 2500,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            resolve(j.healthy === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

class Agent {
  constructor(config) {
    this.config = config;
    this.state = loadState();
    this.opencodeChild = null;
    this.frpcChild = null;
    this.stopRequested = false;
  }

  get hubBase() {
    const { address, port, fingerprint } = this.config.hub;
    return `${fingerprint ? "https" : "http"}://${address}:${port}`;
  }

  get hubFingerprint() {
    return this.config.hub?.fingerprint || "";
  }

  async register() {
    const res = await httpJson("POST", `${this.hubBase}/register`, {
      name: this.config.name,
      joinKey: this.config.joinKey,
      version: VERSION,
    }, {}, 10000, this.hubFingerprint);
    if (res.status === 200 && res.json?.ok) {
      this.state = {
        id: res.json.node.id || res.json.node.name,
        name: res.json.node.name || this.config.name,
        token: res.json.node.token,
        stcpSecret: res.json.node.stcpSecret,
        opencodeRemotePort: res.json.node.opencodeRemotePort,
        agentRemotePort: res.json.node.agentRemotePort,
        frps: res.json.frps,
      };
      saveState(this.state);
      log(`注册成功：node=${this.state.name}（id ${this.state.id}；stcp 模式；主控绑定端口 ${this.state.opencodeRemotePort}/${this.state.agentRemotePort}）`);
      return true;
    }
    log(`注册失败（${res.status}）：${res.json?.error || res.text}`);
    return false;
  }

  /** 身份模型：节点名是可变标签，注册 token 是不可变的唯一身份。
   *  启动时以 token 向 Hub 迁移/确认名称（幂等）。
   *  返回 "ok" | "conflict" | "unauthorized" | "unsupported"（旧版 Hub）| "error" */
  async renameTo() {
    const res = await httpJson("POST", `${this.hubBase}/rename`, {
      name: this.config.name,
      token: this.state.token,
    }, {}, 10000, this.hubFingerprint);
    if (res.status === 200 && res.json?.ok) {
      const old = res.json.renamedFrom || this.state.name || this.config.name;
      this.state = {
        ...this.state,
        id: res.json.node.id || this.state.id || res.json.node.name,
        name: res.json.node.name,
        stcpSecret: res.json.node.stcpSecret || this.state.stcpSecret,
        opencodeRemotePort: res.json.node.opencodeRemotePort ?? this.state.opencodeRemotePort,
        agentRemotePort: res.json.node.agentRemotePort ?? this.state.agentRemotePort,
        frps: res.json.frps || this.state.frps,
      };
      saveState(this.state);
      if (old !== res.json.node.name) {
        log(`改名成功（显示名）："${old}" → "${res.json.node.name}"（注册 id ${this.state.id} 不变，保留端口与凭据）`);
      }
      return "ok";
    }
    if (res.status === 404) return "unsupported";
    if (res.status === 409) return "conflict";
    if (res.status === 401) return "unauthorized";
    log(`身份迁移请求失败（${res.status}）：${res.json?.error || res.text}`);
    return "error";
  }

  async ensureRegistered() {
    if (this.state?.token && this.state?.stcpSecret) {
      while (!this.stopRequested) {
        const r = await this.renameTo();
        if (r === "ok") return true;
        if (r === "unsupported") {
          if (this.state.name && this.state.name !== this.config.name) {
            log(`当前 Hub 不支持改名迁移：请重置身份并使用新的加入密钥重新注册（原名称 "${this.state.name}"）`);
            this.state = null;
            try { saveState(null); } catch {}
            break;
          }
          return true;
        }
        if (r === "conflict") {
          log(`名称 "${this.config.name}" 已被其他节点占用：请改用其他名称（30 秒后重试）`);
          await new Promise((r2) => setTimeout(r2, 30000));
          continue;
        }
        if (r === "unauthorized") {
          log("本地注册凭据已失效（可能已被吊销）：将以加入密钥重新注册…");
          this.state = null;
          try { saveState(null); } catch {}
          break;
        }
        log("身份迁移失败（网络或服务异常），30 秒后重试…");
        await new Promise((r2) => setTimeout(r2, 30000));
      }
    } else if (this.state?.token && !this.state?.stcpSecret) {
      log("本地状态缺少 stcpSecret（旧版 tcp 状态），尝试用现有 joinKey 重新注册…");
    }
    while (!this.stopRequested) {
      if (await this.register()) return true;
      log("30 秒后重试注册…");
      await new Promise((r) => setTimeout(r, 30000));
    }
    return false;
  }

  writeFrpcConfig() {
    const { frps, stcpSecret } = this.state;
    const id = this.state.id || this.config.name;
    const opencodePort = this.config.opencode.port;
    const agentPort = this.config.agent.port;
    const toml = `serverAddr = "${frps.addr}"
serverPort = ${frps.port}
auth.method = "token"
auth.token = "${frps.token}"

# stcp：服务不暴露公网端口，主控侧用 visitor + secretKey 接入
# 代理名使用不可变的注册 id（改名不影响隧道）
[[proxies]]
name = "${id}_opencode"
type = "stcp"
secretKey = "${stcpSecret}"
localIP = "127.0.0.1"
localPort = ${opencodePort}
transport.useEncryption = true

[[proxies]]
name = "${id}_agent"
type = "stcp"
secretKey = "${stcpSecret}"
localIP = "127.0.0.1"
localPort = ${agentPort}
transport.useEncryption = true
`;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FRPC_CONFIG, toml);
    try { fs.chmodSync(FRPC_CONFIG, 0o600); } catch {}
  }

  startFrpc() {
    let binary = this.config.frpc?.binary || "frpc";
    if (!path.isAbsolute(binary)) {
      const rootRel = path.join(ROOT, binary);
      if (fs.existsSync(rootRel)) binary = rootRel;
    }
    this.writeFrpcConfig();
    const args = ["-c", FRPC_CONFIG];
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.frpcChild = child;
    child.stdout.on("data", (d) => log(`[frpc] ${String(d).trim()}`));
    child.stderr.on("data", (d) => log(`[frpc] ${String(d).trim()}`));
    child.on("exit", (code) => {
      this.frpcChild = null;
      if (this.stopRequested) return;
      log(`frpc 退出（code=${code}），5 秒后重启`);
      setTimeout(() => !this.stopRequested && this.startFrpc(), 5000);
    });
    log(`frpc 已启动（${binary}）`);
  }

  /** 重读磁盘配置：让 opencode 密码/端口等变更无需重启 agent 即可生效 */
  reloadRuntimeConfig() {
    try {
      const fresh = loadConfig();
      if (fresh.opencode) this.config.opencode = { ...this.config.opencode, ...fresh.opencode };
      if (fresh.agent?.port) this.config.agent.port = fresh.agent.port;
      if (fresh.frpc) this.config.frpc = { ...(this.config.frpc || {}), ...fresh.frpc };
    } catch (e) {
      log("重读配置失败（沿用内存配置）：" + (e.message || e));
    }
  }

  /** 启动时把 node.json 中的明文密码迁移为加密存储（一次性；幂等） */
  migrateSecretsToSealed() {
    try {
      const raw = loadRawConfig();
      const oc = raw.opencode || {};
      if (oc.passwordEnc) return;
      if (!oc.password) return;
      const plain = String(oc.password);
      oc.passwordEnc = secretStore.isSealed(plain) ? plain : secretStore.seal(plain);
      delete oc.password;
      raw.opencode = oc;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
      try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
      this.config.opencode.passwordEnc = oc.passwordEnc;
      if (oc.passwordEnc.startsWith(secretStore.PLAIN_PREFIX)) {
        log(`凭据已迁移：当前系统无可用密钥环，使用受限文件回退（plain，600 权限）`);
      } else {
        log(`凭据已加密存储（backend=${secretStore.backendName()}）`);
      }
    } catch (e) {
      log("凭据加密迁移失败（保留明文原状）：" + (e.message || e));
    }
  }

  /** 把新密码加密写回 node.json（保留其余字段） */
  persistSealedPassword(newPassword) {
    const raw = loadRawConfig();
    raw.opencode = raw.opencode || {};
    raw.opencode.passwordEnc = secretStore.seal(newPassword);
    delete raw.opencode.password;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2));
    try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    this.config.opencode.passwordEnc = raw.opencode.passwordEnc;
  }

  /** 修改本机 opencode 密码：agent 内部校验旧密码 → 加密持久化 → 重启 opencode */
  async changeOpencodePassword(oldPassword, newPassword) {
    const cur = this.config.opencode.password || "";
    const locked = !!this.config.opencode._pwError;
    if (newPassword.length < 8) return { ok: false, code: 400, error: "新密码过短（至少 8 位）" };
    if (newPassword === cur && cur) return { ok: false, code: 400, error: "新密码与当前密码相同" };
    if (cur) {
      if (!tokenEquals(oldPassword, cur)) {
        return { ok: false, code: 403, error: "原密码不正确（请输入当前网络共用密码）" };
      }
    } else if (!locked) {
      return { ok: false, code: 409, error: "当前未设置密码" };
    }
    // locked=true 且密码不可解：agent token 已鉴权通过，允许直接重置（恢复路径）
    try {
      this.persistSealedPassword(newPassword);
    } catch (e) {
      return { ok: false, code: 500, error: "凭据保存失败：" + (e.message || e) };
    }
    this.config.opencode.password = newPassword;
    delete this.config.opencode._pwError;
    await this.stopOpencode();
    const ok = await this.startOpencode();
    return { ok: true, restarted: true, running: ok, recovered: locked };
  }

  async startOpencode() {
    this.reloadRuntimeConfig();
    const port = this.config.opencode.port;
    if (this.config.opencode._pwError && !this.config.opencode.password) {
      log(`拒绝启动 opencode：${this.config.opencode._pwError}（请在 App「组网」页重置密码）`);
      return false;
    }
    if (await opencodeHealthy(port, this.config.opencode.password)) {
      log("opencode 已在运行，跳过启动");
      return true;
    }
    const busyPid = await findPidByPort(port);
    if (busyPid) {
      log(`端口 ${port} 已被 PID ${busyPid} 占用，但健康检查未通过（密码不匹配或其他程序占用）。请在 node.json 更换 opencode.port 后重启 agent`);
      return false;
    }
    const password = this.config.opencode.password || "";
    const env = { ...process.env };
    if (password) env.OPENCODE_SERVER_PASSWORD = password;
    // 显式绑定回环：不依赖上游默认值，杜绝监听 0.0.0.0 的可能
    const cmd = `opencode serve --hostname 127.0.0.1 --port ${port}`;
    const child = spawn(cmd, { shell: true, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
    this.opencodeChild = child;
    child.stdout.on("data", (d) => log(`[opencode] ${String(d).trim()}`));
    child.stderr.on("data", (d) => log(`[opencode] ${String(d).trim()}`));
    child.on("exit", (code) => {
      log(`opencode 进程退出（code=${code}）`);
      this.opencodeChild = null;
    });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await opencodeHealthy(port, password)) {
        log("opencode 已就绪");
        return true;
      }
    }
    log("opencode 启动超时（20s 内未就绪）");
    return false;
  }

  async stopOpencode() {
    this.reloadRuntimeConfig();
    const port = this.config.opencode.port;
    const pid = await findPidByPort(port);
    if (!pid) {
      log("stop opencode：未找到监听进程");
      return false;
    }
    await killPid(pid);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 700));
      if (!(await opencodeHealthy(port, this.config.opencode.password))) {
        log("opencode 已停止");
        return true;
      }
    }
    log("opencode 停止超时");
    return false;
  }

  async statusOpencode() {
    this.reloadRuntimeConfig();
    const port = this.config.opencode.port;
    const healthy = await opencodeHealthy(port, this.config.opencode.password);
    const pid = await findPidByPort(port);
    return { running: healthy, pid };
  }

  startControlServer() {
    const token = this.state.token;
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      const reply = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(body));
      };
      if (route === "GET /health") {
        return reply(200, { ok: true, name: this.config.name, version: VERSION });
      }
      if (!tokenEquals(req.headers["x-agent-token"], token)) {
        return reply(401, { ok: false, error: "unauthorized" });
      }
      try {
        if (route === "GET /opencode/status") {
          return reply(200, { ok: true, ...(await this.statusOpencode()) });
        }
        if (route === "POST /opencode/start") {
          const ok = await this.startOpencode();
          return reply(200, { ok, ...(await this.statusOpencode()) });
        }
        if (route === "POST /opencode/stop") {
          const ok = await this.stopOpencode();
          return reply(200, { ok, ...(await this.statusOpencode()) });
        }
        if (route === "POST /opencode/restart") {
          await this.stopOpencode();
          const ok = await this.startOpencode();
          return reply(200, { ok, ...(await this.statusOpencode()) });
        }
        if (route === "POST /opencode/password") {
          const body = await readBody(req);
          if (body === null) return reply(400, { ok: false, error: "bad json" });
          const r = await this.changeOpencodePassword(String(body.oldPassword || ""), String(body.newPassword || ""));
          return reply(r.code || (r.ok ? 200 : 400), r);
        }
        return reply(404, { ok: false, error: "not found" });
      } catch (e) {
        return reply(500, { ok: false, error: e.message });
      }
    });
    const port = this.config.agent.port;
    server.listen(port, "127.0.0.1", () => log(`控制 API 监听 127.0.0.1:${port}`));
  }

  startHeartbeat() {
    const send = async () => {
      const res = await httpJson(
        "POST",
        `${this.hubBase}/heartbeat`,
        {
          id: this.state.id || this.config.name,
          name: this.config.name,
          version: VERSION,
          os: process.platform,
          arch: process.arch,
        },
        { "X-Node-Token": this.state.token },
        10000,
        this.hubFingerprint
      );
      if (res.status === 401) log("心跳被拒绝（可能已被吊销）");
    };
    send();
    setInterval(send, 60_000);
  }

  async run() {
    log(`Aoi mesh node agent v${VERSION} 启动（node=${this.config.name}）`);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, "agent.pid"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), marker: __filename }));
    } catch {}
    this.migrateSecretsToSealed();
    if (!(await this.ensureRegistered())) return;
    this.writeFrpcConfig();
    this.startFrpc();
    this.startControlServer();
    if (this.config.opencode.autoStart !== false) {
      await this.startOpencode();
    }
    this.startHeartbeat();
    log("agent 就绪");
  }

  shutdown() {
    this.stopRequested = true;
    log("正在退出：清理 frpc / opencode…");
    if (this.frpcChild) this.frpcChild.kill();
    if (this.opencodeChild) {
      try { this.opencodeChild.kill(); } catch {}
    }
    try { fs.unlinkSync(path.join(DATA_DIR, "agent.pid")); } catch {}
    setTimeout(() => process.exit(0), 1000);
  }
}

const config = loadConfig();
config.name = config.name || os.hostname();
config.opencode = config.opencode || { port: 4096, password: "", autoStart: true };
config.agent = config.agent || { port: 41999 };
const agent = new Agent(config);
process.on("SIGINT", () => agent.shutdown());
process.on("SIGTERM", () => agent.shutdown());
agent.run().catch((e) => {
  log(`agent 异常：${e.stack || e.message}`);
  process.exit(1);
});
