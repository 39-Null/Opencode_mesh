const { app, BrowserWindow, ipcMain, shell, clipboard, Tray, Menu, nativeImage, net, screen } = require("electron");
const { exec, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
let mesh = require("./mesh-core");

const IS_WIN = process.platform === "win32";
const ROOT = mesh.findRepoRoot();

// 薄壳化：发行版优先加载仓库目录中的 mesh-core（asar 内置副本仅作引导与兜底）。
// 仓库副本存在时以它为准——这样「拉取源码覆盖」即可更新界面与应用逻辑。
try {
  const repoMesh = path.join(ROOT, "node-app", "mesh-core.js");
  if (fs.existsSync(repoMesh)) mesh = require(repoMesh);
} catch (e) {
  console.error("[mesh] 仓库 mesh-core 加载失败，回退内置副本：", e.message);
}
const APP_HOME = IS_WIN
  ? path.join(process.env.APPDATA || "", "opencode-telegram-bot")
  : path.join(os.homedir(), ".config", "opencode-telegram-bot");
const ENV_FILE = path.join(APP_HOME, ".env");
const LOG_DIR = path.join(APP_HOME, "logs");
const STARTUP_VBS = path.join(
  process.env.APPDATA || "",
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Startup",
  "opencode-telegram-bot.vbs"
);
const TG_API = "https://api.telegram.org";
const ICON = IS_WIN
  ? path.join(__dirname, "assets", "icon.ico")
  : path.join(__dirname, "assets", "Aoi.png");

function botEndpoint() {
  return mesh.envEndpoint(ENV_FILE, "OPENCODE_API_URL", "127.0.0.1", 4096);
}
function proxyEndpoint() {
  return mesh.envEndpoint(ENV_FILE, "TELEGRAM_PROXY_URL", "127.0.0.1", 10090);
}
function curlProxyArg() {
  const p = proxyEndpoint();
  return p.raw && /^socks/i.test(p.raw) ? p.raw : `http://${p.host}:${p.port}`;
}

function execCmd(command, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(command, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve(String(stdout || "") + String(stderr || ""));
    });
  });
}

function execFileP(file, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function runCli(args, timeoutMs = 30000) {
  const cli = mesh.resolveBotCli();
  if (!cli) {
    return Promise.resolve(
      "[未找到 opencode-telegram 命令：请确认 bot 已安装（npm i -g @grinev/opencode-telegram-bot），或在环境变量 OPENCODE_TELEGRAM_CLI 中指定其完整路径]"
    );
  }
  return execCmd(`"${cli}" ${args.join(" ")}`, timeoutMs);
}

const tcpProbe = mesh.tcpProbe;
const findPidByPort = mesh.findPidByPort;

async function opencodeHealth() {
  const ep = botEndpoint();
  try {
    const r = await fetch(`http://${ep.host}:${ep.port}/global/health`, {
      signal: AbortSignal.timeout(3000),
    });
    const j = await r.json();
    return { ok: j.healthy === true, version: j.version || "", port: ep.port };
  } catch {
    return { ok: false, version: "", port: ep.port };
  }
}

async function getProcMemory(pid) {
  if (!IS_WIN || !pid) return "";
  const out = await execCmd(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, 15000);
  const m = out.match(/"([\d,.\s]+ K)"/);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

async function getBotStatus() {
  const out = await runCli(["status"], 20000);
  const m = out.match(/Service status:\s*(\w+)/i);
  const pidM = out.match(/PID:\s*(\d+)/);
  const upM = out.match(/Uptime:\s*([^\r\n]+)/);
  return {
    running: m ? /running/i.test(m[1]) : /Uptime:/.test(out),
    pid: pidM ? Number(pidM[1]) : null,
    uptime: upM ? upM[1].trim() : "",
  };
}

function readEnvValue(key) {
  try {
    const text = fs.readFileSync(ENV_FILE, "utf8");
    const m = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

async function getStatus() {
  const proxyEp = proxyEndpoint();
  const [bot, oc, proxyOk] = await Promise.all([
    getBotStatus(),
    opencodeHealth(),
    tcpProbe(proxyEp.host, proxyEp.port),
  ]);
  let ocPid = null;
  let ocMem = "";
  if (oc.ok) {
    ocPid = await findPidByPort(oc.port);
    if (ocPid) ocMem = await getProcMemory(ocPid);
  }
  return {
    hostname: os.hostname(),
    platform: process.platform,
    bot: { ...bot, cliFound: !!mesh.resolveBotCli() },
    opencode: { healthy: oc.ok, version: oc.version, pid: ocPid, mem: ocMem, port: oc.port },
    proxy: { ok: proxyOk, host: proxyEp.host, port: proxyEp.port },
    autostart: IS_WIN ? fs.existsSync(STARTUP_VBS) : null,
  };
}

async function restartBot() {
  const steps = [];
  await runCli(["stop"], 30000);
  steps.push("已停止旧进程");
  await new Promise((r) => setTimeout(r, 1000));
  await runCli(["start", "--daemon"], 60000);
  steps.push("已启动新进程");
  await new Promise((r) => setTimeout(r, 3500));
  const bot = await getBotStatus();
  steps.push(bot.running ? "连接已恢复" : "启动后未检测到运行，请查看日志");
  return { ok: bot.running, steps };
}

async function runDiagnostics() {
  const results = [];
  const proxyEp = proxyEndpoint();

  const proxyOk = await tcpProbe(proxyEp.host, proxyEp.port);
  results.push({
    name: `代理端口 ${proxyEp.port}`,
    ok: proxyOk,
    detail: proxyOk ? "可连接" : "无法连接",
    hint: proxyOk
      ? ""
      : `启动代理软件并确认监听 ${proxyEp.host}:${proxyEp.port}（可通过 bot .env 的 TELEGRAM_PROXY_URL 调整）`,
  });

  let tg = { ok: false, detail: "跳过（代理不可用）", hint: "" };
  const token = readEnvValue("TELEGRAM_BOT_TOKEN");
  if (proxyOk && !token) {
    tg = { ok: false, detail: "未找到 token", hint: `检查 ${ENV_FILE}` };
  } else if (proxyOk && token) {
    const r = await execFileP(
      "curl.exe",
      ["-x", curlProxyArg(), "-s", "-m", "10", `${TG_API}/bot${token}/getMe`],
      15000
    );
    const execErr = r.err ? String(r.err.message || r.err) : "";
    if (/ENOENT/.test(execErr)) {
      tg = { ok: false, detail: "未找到 curl 命令", hint: "安装 curl 后重试（Windows 10+ / 主流 Linux 自带）" };
    } else {
      try {
        const j = JSON.parse(r.stdout);
        tg = j.ok
          ? { ok: true, detail: `@${j.result.username}`, hint: "" }
          : { ok: false, detail: j.description || "API 拒绝", hint: "token 可能已失效，建议 /revoke 换新" };
      } catch {
        tg = { ok: false, detail: "HTTP 无响应", hint: "检查代理是否真正连通外网" };
      }
    }
  }
  results.push({ name: "Telegram API", ...tg });

  const oc = await opencodeHealth();
  results.push({
    name: "opencode 服务器",
    ok: oc.ok,
    detail: oc.ok ? `v${oc.version}` : "未运行",
    hint: oc.ok ? "" : "Telegram 内发 /opencode_start，或手动运行 opencode serve",
  });

  const bot = await getBotStatus();
  const cliFound = !!mesh.resolveBotCli();
  results.push({
    name: "bot 服务",
    ok: bot.running,
    detail: bot.running ? `运行中 · ${bot.uptime || "刚刚"}` : cliFound ? "已停止" : "未找到 bot 命令",
    hint: bot.running
      ? ""
      : cliFound
        ? "点击右上角「重启连接」"
        : "安装 bot（npm i -g @grinev/opencode-telegram-bot），或设置环境变量 OPENCODE_TELEGRAM_CLI",
  });

  if (IS_WIN) {
    results.push({ name: "开机自启", ok: fs.existsSync(STARTUP_VBS), detail: fs.existsSync(STARTUP_VBS) ? "已配置" : "未配置", hint: fs.existsSync(STARTUP_VBS) ? "" : "把 start-bot.vbs 放入启动文件夹以启用自启" });
  }

  return results;
}

async function logsTail(maxLines = 200) {
  try {
    if (!fs.existsSync(LOG_DIR)) return { ok: false, error: "日志目录不存在", file: "", lines: [] };
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^bot-.*\.log$/.test(f))
      .map((f) => path.join(LOG_DIR, f));
    if (!files.length) return { ok: false, error: "尚无日志文件", file: "", lines: [] };
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const file = files[0];
    const all = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const lines = all
      .slice(Math.max(0, all.length - maxLines))
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
      .filter((l) => l.length > 0);
    return { ok: true, file: path.basename(file), lines };
  } catch (e) {
    return { ok: false, error: e.message, file: "", lines: [] };
  }
}

function backupEnv() {
  if (!fs.existsSync(ENV_FILE)) return "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${ENV_FILE}.bak-${stamp}`;
  fs.copyFileSync(ENV_FILE, bak);
  const baks = fs
    .readdirSync(APP_HOME)
    .filter((f) => f.startsWith(".env.bak-"))
    .sort();
  while (baks.length > 5) {
    fs.unlinkSync(path.join(APP_HOME, baks.shift()));
  }
  return path.basename(bak);
}

async function rotateToken(newToken) {
  const steps = [];
  const token = String(newToken || "").trim();
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
    return { ok: false, steps: ["token 格式不正确（应为 123456:ABC… 形式）"] };
  }

  const r = await execFileP(
    "curl.exe",
    ["-x", curlProxyArg(), "-s", "-m", "10", `${TG_API}/bot${token}/getMe`],
    15000
  );
  if (r.err && /ENOENT/.test(String(r.err.message || r.err))) {
    return { ok: false, steps: ["未找到 curl 命令，无法校验新 token（Windows 10+ 与主流 Linux 自带 curl）"] };
  }
  let me = null;
  try {
    const j = JSON.parse(r.stdout);
    if (j.ok) me = j.result;
  } catch {}
  if (!me) {
    return {
      ok: false,
      steps: ["新 token 校验失败（getMe 未通过），未做任何修改", "请确认已通过 @BotFather /revoke 获取了新 token，且代理可用"],
    };
  }
  steps.push(`新 token 有效：@${me.username}`);

  try {
    const bak = backupEnv();
    if (bak) steps.push(`已备份 .env → ${bak}`);
    let text = fs.readFileSync(ENV_FILE, "utf8");
    if (/^TELEGRAM_BOT_TOKEN=/m.test(text)) {
      text = text.replace(/^TELEGRAM_BOT_TOKEN=.*$/m, `TELEGRAM_BOT_TOKEN=${token}`);
    } else {
      text = `TELEGRAM_BOT_TOKEN=${token}\n${text}`;
    }
    fs.writeFileSync(ENV_FILE, text, "utf8");
    steps.push("已写入新 token 到 .env");

    await runCli(["stop"], 30000);
    steps.push("已停止 bot");
    await new Promise((res) => setTimeout(res, 1000));
    await runCli(["start", "--daemon"], 60000);
    await new Promise((res) => setTimeout(res, 3500));
    const bot = await getBotStatus();
    steps.push(bot.running ? "bot 已用新 token 重启并运行" : "bot 重启后未检测到运行，请查看日志");
    return { ok: bot.running, steps };
  } catch (e) {
    return { ok: false, steps: [...steps, `失败：${e.message}`] };
  }
}

ipcMain.handle("status", getStatus);
ipcMain.handle("restart", restartBot);
ipcMain.handle("diagnostics", runDiagnostics);
ipcMain.handle("logs:tail", () => logsTail(200));
ipcMain.handle("logs:openDir", () => {
  if (fs.existsSync(LOG_DIR)) shell.openPath(LOG_DIR);
  return true;
});
ipcMain.handle("token:rotate", (_e, token) => rotateToken(token));

/* ==================== 设置 / 主控（mesh-core） ==================== */
ipcMain.handle("mesh:node:get", () => mesh.getNodeConfig(ROOT));
ipcMain.handle("mesh:node:save", (_e, cfg) => {
  try {
    mesh.saveNodeConfig(ROOT, cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:node:start", () => mesh.startAgent(ROOT));
ipcMain.handle("mesh:node:startFull", () => mesh.startNodeFull(ROOT));
ipcMain.handle("mesh:node:stop", () => mesh.stopAgent(ROOT));
ipcMain.handle("mesh:node:log", () => mesh.agentLogTail(ROOT, 150));
ipcMain.handle("mesh:node:restartOpencode", () => mesh.restartLocalOpencode(ROOT));
ipcMain.handle("mesh:node:changePassword", (_e, payload) => mesh.changeNodePassword(ROOT, payload || {}));
ipcMain.handle("mesh:node:reset", () => {
  try {
    return mesh.resetNodeState(ROOT);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle("mesh:master:get", () => mesh.getMasterConfig(ROOT));
ipcMain.handle("mesh:master:save", (_e, cfg) => {
  try {
    mesh.saveMasterConfig(ROOT, cfg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:master:sync", () => mesh.syncMasterNodes(ROOT));
ipcMain.handle("mesh:master:prune", () => mesh.pruneMasterNodes(ROOT));
ipcMain.handle("mesh:master:list", () => mesh.listNodesMerged(ROOT));
ipcMain.handle("mesh:master:action", (_e, p) => mesh.nodeAction(ROOT, p?.name, p?.action));
ipcMain.handle("mesh:master:visitors:ensure", (_e, opts) => mesh.ensureVisitor(ROOT, opts || {}));
ipcMain.handle("mesh:master:visitors:setEnabled", (_e, enabled) => mesh.setVisitorEnabled(ROOT, !!enabled));
ipcMain.handle("mesh:master:visitors:status", () => mesh.visitorStatus(ROOT));
ipcMain.handle("mesh:master:visitors:log", () => mesh.visitorLogTail(ROOT, 150));
ipcMain.handle("mesh:master:fleet", () => mesh.fleetSnippet(ROOT));
ipcMain.handle("mesh:master:mcpStatus", () => {
  try {
    return mesh.getMcpStatus(ROOT);
  } catch (e) {
    return { status: "error", note: e.message };
  }
});
ipcMain.handle("mesh:master:mcpWrite", (_e, opts) => {
  try {
    return mesh.writeMcpConfig(ROOT, opts || {});
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:master:mcpRemove", () => {
  try {
    return mesh.removeMcpConfig(ROOT);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:master:export", async () => {
  try {
    const payload = mesh.buildMasterExport(ROOT);
    await clipboard.writeText(JSON.stringify(payload, null, 2));
    return { ok: true, registry: payload.registry.address, nodes: Object.keys(payload.nodes || {}).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:master:import", async () => {
  try {
    const text = String((await clipboard.readText()) ?? "");
    if (!text.trim()) return { ok: false, error: "剪贴板为空（或读取被占用），请重试" };
    const r = mesh.applyMasterImport(ROOT, text);
    const s = await mesh.syncMasterNodes(ROOT);
    return { ...r, synced: s.ok ? s.count : null, syncError: s.ok ? null : s.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ==================== 应用更新（设置页「应用 · 版本与更新」） ==================== */

const UPDATE_REPO = { owner: "39-Null", repo: "Opencode_mesh" }; // canonical 仓库名（旧名 Aoi_mesh 由 GitHub 重定向）

function localAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "node-app", "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 把 HTTP 状态与响应体压缩成可读错误（避免出现 error: undefined） */
function httpErrorDetail(status, text) {
  let detail = "";
  try {
    const j = JSON.parse(String(text || ""));
    detail = j.message || j.error || j.documentation_url || "";
  } catch {}
  if (!detail) detail = String(text || "").replace(/\s+/g, " ").trim().slice(0, 180);
  return `HTTP ${status}${detail ? " · " + detail : ""}`;
}

/** Electron net 请求（自动跟随系统代理；跟随 3xx，带错误状态与响应摘要） */
function netRequest(url, { timeoutMs = 20000, redirects = 5 } = {}) {
  return new Promise((resolve) => {
    let req;
    try { req = net.request(url); } catch (e) { return resolve({ ok: false, error: e?.message || String(e) }); }
    let data = "";
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => { try { req.abort(); } catch {} finish({ ok: false, error: "请求超时" }); }, timeoutMs);
    req.on("response", (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        clearTimeout(timer);
        const loc = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
        try { req.abort(); } catch {}
        if (!loc) return finish({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode} 重定向缺少 Location` });
        if (redirects <= 0) return finish({ ok: false, status: res.statusCode, error: `重定向次数过多（HTTP ${res.statusCode}）` });
        let next = loc;
        try { next = new URL(loc, url).toString(); } catch {}
        netRequest(next, { timeoutMs, redirects: redirects - 1 }).then(finish);
        return;
      }
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        clearTimeout(timer);
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        finish({ ok, status: res.statusCode, text: data, error: ok ? "" : httpErrorDetail(res.statusCode, data) });
      });
    });
    req.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e?.message || String(e) }); });
    req.end();
  });
}

/** Electron net 流式下载到文件 */
function netDownload(url, dest, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let req;
    try { req = net.request(url); } catch (e) { return resolve({ ok: false, error: e.message }); }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => { try { req.abort(); } catch {} finish({ ok: false, error: "下载超时" }); }, timeoutMs);
    req.on("response", (res) => {
      if (res.statusCode >= 400) {
        clearTimeout(timer);
        res.resume();
        return finish({ ok: false, error: `HTTP ${res.statusCode}` });
      }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on("finish", () => { clearTimeout(timer); finish({ ok: true }); });
      ws.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
      res.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    });
    req.on("error", (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
    req.end();
  });
}

/** 用 curl 取文本/下载文件；显式区分直连与代理，并保留真实错误/状态 */
async function curlFetch(url, { proxy = "", timeoutMs = 30000, output = "" } = {}) {
  const marker = "__MESH_HTTP_STATUS__";
  const args = ["-L", "--silent", "--show-error", "--max-time", String(Math.max(1, Math.round(timeoutMs / 1000)))];
  if (proxy) args.push("--proxy", proxy);
  else args.push("--noproxy", "*");
  if (output) args.push("-o", output);
  args.push("-w", `\n${marker}:%{http_code}`, url);
  const ex = await execFileP(IS_WIN ? "curl.exe" : "curl", args, timeoutMs + 5000);
  const errText = String(ex.stderr || "").trim();
  if (ex.err && /ENOENT/.test(String(ex.err.message || ex.err))) return { ok: false, error: "未找到 curl" };
  const idx = ex.stdout.lastIndexOf(marker + ":");
  const status = idx >= 0 ? Number(ex.stdout.slice(idx + marker.length + 1).trim()) || 0 : 0;
  if (output) {
    if (ex.err) {
      try { fs.rmSync(output, { force: true }); } catch {}
      return { ok: false, error: errText || ex.err.message || String(ex.err) };
    }
    if (status && (status < 200 || status >= 400)) {
      let snippet = "";
      try { snippet = fs.readFileSync(output, "utf8").slice(0, 300); } catch {}
      try { fs.rmSync(output, { force: true }); } catch {}
      return { ok: false, status, error: httpErrorDetail(status, snippet) };
    }
    try {
      const size = fs.statSync(output).size;
      if (size > 0) return { ok: true, status, size };
    } catch {}
    return { ok: false, status, error: "curl 返回空文件" };
  }
  const text = idx >= 0 ? ex.stdout.slice(0, idx).replace(/\r?\n$/, "") : ex.stdout;
  if (status >= 200 && status < 400) return { ok: true, status, text };
  if (status) return { ok: false, status, text, error: httpErrorDetail(status, text) };
  return { ok: false, error: errText || ex.err?.message || String(ex.err) || "curl 请求失败" };
}

/** 文本请求回退链：系统网络 → bot 代理（可达时）→ curl 直连（每步保留真实错误） */
async function fetchTextWithFallback(url, { timeoutMs = 20000 } = {}) {
  const errors = [];
  const r = await netRequest(url, { timeoutMs });
  if (r.ok) return r;
  errors.push(`系统网络：${r.error || (r.status ? `HTTP ${r.status}` : "失败")}`);

  const proxy = curlProxyArg();
  const proxyEp = proxyEndpoint();
  let proxyAlive = false;
  try {
    proxyAlive = typeof mesh.tcpProbe === "function" ? await mesh.tcpProbe(proxyEp.host, proxyEp.port) : true;
  } catch {}
  if (proxyAlive) {
    const viaProxy = await curlFetch(url, { proxy, timeoutMs: Math.min(timeoutMs, 30000) });
    if (viaProxy.ok) return viaProxy;
    errors.push(`curl 代理 ${proxy}：${viaProxy.error || "失败"}`);
  } else {
    errors.push(`curl 代理 ${proxy}：端口不可达`);
  }

  const direct = await curlFetch(url, { timeoutMs: Math.min(timeoutMs, 30000) });
  if (direct.ok) return direct;
  errors.push(`curl 直连：${direct.error || "失败"}`);

  return { ok: false, error: errors.join("；") };
}

/** 文件下载回退链：代理（可用时优先）→ 系统网络 → curl 直连 */
async function downloadWithFallback(url, dest) {
  const attempts = [];
  const proxy = curlProxyArg();
  const proxyEp = proxyEndpoint();
  let proxyOk = false;
  try {
    proxyOk = typeof mesh.tcpProbe === "function" ? await mesh.tcpProbe(proxyEp.host, proxyEp.port) : true;
  } catch {}
  if (proxyOk) {
    const viaProxy = await curlFetch(url, { proxy, timeoutMs: 120000, output: dest });
    if (viaProxy.ok) return viaProxy;
    attempts.push(`代理 ${proxy}：${viaProxy.error || "失败"}`);
  }

  const r = await netDownload(url, { timeoutMs: 120000 });
  if (r.ok) return r;
  attempts.push(`系统网络：${r.error || (r.status ? `HTTP ${r.status}` : "失败")}`);

  const direct = await curlFetch(url, { timeoutMs: 120000, output: dest });
  if (direct.ok) return direct;
  attempts.push(`curl 直连：${direct.error || "失败"}`);

  return { ok: false, error: `下载失败（${attempts.join("；")}）` };
}

/** 从 GitHub tags Atom 源解析 tag 名称（优先取 entry id 末段，兼容 lightweight tag 的 title 为提交信息） */
function parseTagsAtom(xml) {
  const tags = [];
  const re = /<entry\b[\s\S]*?<\/entry>/g;
  let m;
  while ((m = re.exec(String(xml || "")))) {
    const entry = m[0];
    const id = /<id>([\s\S]*?)<\/id>/.exec(entry)?.[1] || "";
    const title = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] || "";
    const raw = (id.split("/").pop() || title)
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (raw) tags.push({ name: raw, commit: { sha: "" } });
  }
  return tags;
}

async function fetchGitHubTags() {
  const atomUrl = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/tags.atom`;
  const atom = await fetchTextWithFallback(atomUrl, { timeoutMs: 15000 });
  if (atom.ok) {
    const tags = parseTagsAtom(atom.text);
    if (tags.length && mesh.pickLatestTag(tags)) return { ok: true, tags, source: "atom" };
  }

  const apiUrl = `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/tags`;
  const r = await fetchTextWithFallback(apiUrl, { timeoutMs: 15000 });
  if (!r.ok) {
    const atomPart = atom.error ? `Atom 源：${atom.error}；` : "";
    return { ok: false, error: `${atomPart}API：${r.error}` };
  }
  let tags = null;
  try { tags = JSON.parse(r.text); } catch {}
  if (!Array.isArray(tags)) return { ok: false, error: "GitHub 标签接口返回内容异常" };
  return { ok: true, tags, source: "api" };
}

async function updateCheck() {
  const current = localAppVersion();
  const fetched = await fetchGitHubTags();
  if (!fetched.ok) return { ok: false, error: fetched.error };
  const latest = mesh.pickLatestTag(fetched.tags);
  if (!latest) return { ok: false, error: "远端没有可用版本 tag" };
  return {
    ok: true,
    current,
    latest: latest.version,
    tag: latest.tag,
    sha: latest.sha || "",
    source: fetched.source,
    hasUpdate: mesh.compareVersions(latest.version, current) > 0,
  };
}

async function updateApply({ tag } = {}) {
  const tagName = String(tag || "");
  if (!/^v?\d+\.\d+\.\d+$/.test(tagName)) return { ok: false, error: "无效的版本 tag" };
  if (fs.existsSync(path.join(ROOT, ".git"))) {
    return { ok: false, error: "检测到 git 仓库（开发环境）：请使用 git pull 更新" };
  }
  if (!fs.existsSync(path.join(ROOT, "node-app", "index.html"))) {
    return { ok: false, error: "当前安装不支持应用内更新（缺少薄壳结构）：请手动更换新版便携包" };
  }
  const tmpBase = path.join(os.tmpdir(), `opencode-mesh-upd-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });
  try {
    const tarPath = path.join(tmpBase, "snapshot.tar.gz");
    // 直接走 codeload，避免 api.github.com 的限流与 302 链
    const url = `https://codeload.github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/tar.gz/refs/tags/${tagName}`;
    const dl = await downloadWithFallback(url, tarPath);
    if (!dl.ok) return { ok: false, error: dl.error };
    const size = fs.statSync(tarPath).size;
    if (size < 10000) return { ok: false, error: `下载内容异常（仅 ${size} 字节）` };
    const ex = await execFileP("tar", ["-xzf", tarPath, "-C", tmpBase], 120000);
    if (ex.err) return { ok: false, error: `解压失败：${ex.stderr || ex.err.message}` };
    const dirs = fs.readdirSync(tmpBase, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (dirs.length !== 1) return { ok: false, error: "快照目录结构异常" };
    const srcRoot = path.join(tmpBase, dirs[0].name);
    let files = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files++;
      }
    })(srcRoot);
    fs.cpSync(srcRoot, ROOT, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = path.relative(srcRoot, src).replace(/\\/g, "/");
        if (!rel) return true;
        if (rel === "node-agent/node.json" || rel.startsWith("node-agent/data/")) return false;
        if (rel === "node-ctl/nodes.json" || rel === "node-ctl/visitors.toml") return false;
        if (rel === "node_modules" || rel.startsWith("node-app/node_modules")) return false;
        return true;
      },
    });
    return { ok: true, tag: tagName, latest: tagName.replace(/^v/, ""), files };
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

ipcMain.handle("app:update:current", () => ({ ok: true, version: localAppVersion() }));
ipcMain.handle("app:update:check", async () => {
  try {
    return await updateCheck();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("app:update:apply", async (_e, opts) => {
  try {
    return await updateApply(opts || {});
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/* ==================== v1.5：会话占用 / 压缩 / 清空 / 策略 ==================== */

ipcMain.handle("mesh:master:contextUsage", async (_e, name) => {
  try {
    return await mesh.nodeContextUsage(ROOT, String(name || ""));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:master:compactSession", async (_e, name) => {
  try {
    return await mesh.compactNodeSession(ROOT, String(name || ""));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:master:clearSession", async (_e, name) => {
  try {
    return await mesh.clearNodeSession(ROOT, String(name || ""));
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:session:policyGet", () => {
  try {
    return mesh.sessionPolicyGet(ROOT);
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle("mesh:session:policySet", (_e, patch) => {
  try {
    return mesh.sessionPolicySet(ROOT, patch || {});
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

let mainWindow = null;
let tray = null;
let trayHintShown = false;
app.isQuitting = false;

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createWindow() {
  // 控制台采用「侧边导航 + 工作区」布局；按屏幕可用区域取尺寸，避免小屏笔记本超出桌面。
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1180, Math.max(900, work.width - 100));
  const height = Math.min(820, Math.max(620, work.height - 80));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 860,
    minHeight: 600,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: "#0a0b0e",
    title: "Aoi mesh",
    ...(fs.existsSync(ICON) ? { icon: ICON } : {}),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  // 薄壳化：优先加载仓库目录中的界面（asar 内置副本仅作兜底）
  const repoIndex = path.join(ROOT, "node-app", "index.html");
  if (fs.existsSync(repoIndex)) mainWindow.loadFile(repoIndex);
  else mainWindow.loadFile("index.html");
  // 关闭窗口 = 最小化到系统托盘（节点 agent / 隧道为独立进程，继续运行）
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      try {
        if (!trayHintShown && tray && process.platform === "win32") {
          tray.displayBalloon({
            title: "Aoi mesh",
            content: "已最小化到系统托盘：节点与隧道保持运行。双击托盘图标恢复窗口；托盘右键菜单可退出。",
          });
          trayHintShown = true;
        }
      } catch {}
    }
  });
}

function createTray() {
  try {
    let img = nativeImage.createFromPath(ICON);
    if (img.isEmpty()) img = nativeImage.createEmpty();
    tray = new Tray(img);
    tray.setToolTip("Aoi mesh（常驻中）");
    const menu = Menu.buildFromTemplate([
      { label: "显示主界面", click: () => showMainWindow() },
      { type: "separator" },
      {
        label: "退出应用",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on("double-click", () => showMainWindow());
    tray.on("click", () => showMainWindow());
  } catch (e) {
    tray = null;
  }
}

ipcMain.handle("app:quit", () => {
  app.isQuitting = true;
  app.quit();
});

/** 启动例程：已配置时每次打开 App 强制拉起本机节点 + 确保隧道 */
async function autoLaunchMesh() {
  try {
    const node = await mesh.getNodeConfig(ROOT);
    if (node.rootFound !== false && node.cfg?.hub?.address && !node.agentRunning) {
      await mesh.startAgent(ROOT);
    }
    await mesh.ensureVisitor(ROOT);
  } catch {}
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 次级实例：直接退出（不注册任何清理逻辑，避免误杀主实例的进程）
  app.quit();
} else {
  // 退出清理（仅主实例）：停隧道 → 停本机节点 → 直报离线；超时兜底后放行退出
  let quitCleanupDone = false;
  app.on("before-quit", (e) => {
    if (quitCleanupDone) return;
    e.preventDefault();
    (async () => {
      // v1.5：可选的入站会话清理（开关在设置页；默认关）——须在 opencode 被停之前执行
      try {
        await Promise.race([
          mesh.cleanupInboundSessions(ROOT).catch(() => {}),
          new Promise((r) => setTimeout(r, 8000)),
        ]);
      } catch {}
      try {
        await Promise.race([
          mesh.shutdownAll(ROOT).catch(() => {}),
          new Promise((r) => setTimeout(r, 12000)),
        ]);
      } catch {}
      quitCleanupDone = true;
      app.quit();
    })();
  });
  app.on("second-instance", () => showMainWindow());
  app.whenReady().then(() => {
    createWindow();
    createTray();
    autoLaunchMesh();
  });
  app.on("window-all-closed", () => {
    if (app.isQuitting) app.quit();
  });
}
