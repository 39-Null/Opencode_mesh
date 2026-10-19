# 部署与运维指南

> 本文覆盖三种角色（Hub / 节点 / 控制端）的部署、App 安装与卸载、**配置字段逐项教学**、升级与故障排查。
> 设计决策与完整时序图见 [DESIGN.md](DESIGN.md)；日常操作见 [USAGE.md](USAGE.md)；消息协议见 [PROTOCOL.md](PROTOCOL.md)。

## 1. 部署概览

### 1.1 角色与职责

| 角色 | 数量 | 说明 |
| --- | --- | --- |
| **Hub** | 1 台 | 公网服务器：注册中心（registry）+ frp 服务端（frps）。只做注册与加密中继 |
| **节点** | 1..n 台 | 任意 Windows / Linux 设备：node-agent 负责注册、隧道、opencode 生命周期 |
| **控制端** | 1..n 台 | 发起操作的设备：App / CLI / MCP / Telegram。可与某节点同机 |

### 1.2 架构与网络流

```
控制端（App / CLI / MCP / Telegram）
  │  本机回环 127.0.0.1:141xx（visitor，不对外监听）
  ▼
Hub（公网服务器）   公网入向仅两个端口：
  ├─ registry  18080    注册 / 心跳 / 密钥 / 吊销
  └─ frps      17000    隧道服务端（stcp，加密中继）
  ▲  出站 stcp 隧道（节点与控制端都只发起出站连接）
  │
节点（node-agent）
  └─ opencode serve（127.0.0.1:4096，仅本机与隧道可达）
```

- 节点与控制端**都不需要公网 IP、不打开任何入站端口**（NAT 友好）
- 节点服务（opencode / agent）为 stcp 模式：Hub 只中继加密流量，不直接暴露服务端口
- 主控侧访问节点 = 控制端本机 `127.0.0.1:141xx` → 隧道 → 节点

三条典型数据流（时序图见 [DESIGN §3.1](DESIGN.md)）：

| 链路 | 路径 |
| --- | --- |
| 入网注册 | 节点 → registry `/register`（加入密钥）→ 分配 id / token / 隧道密钥 → frpc 出站建隧道 → 周期心跳 |
| 远程生命周期 | node-ctl / MCP → 本机 visitor → 隧道 → 节点 agent → 启停 / 查询本机 opencode |
| 任务派发 | 主控 opencode（fleet MCP）→ 同一隧道 → 节点 opencode 执行 → 回执块原路回收 |

### 1.3 前置条件

| 角色 | 要求 |
| --- | --- |
| Hub | Linux（RPM 系优先，Debian 系亦可）、root / sudo；能出站访问网络（安装 Node 与 frp 时用到） |
| 节点 | Windows 或 Linux；Node.js 18+；已安装 opencode；能出站访问 Hub |
| 控制端 | 任意可访问 Hub 的设备；图形界面需 Electron 运行环境（`node-app` 依赖），CLI / MCP 仅需 Node.js 18+ |

> **opencode 自身的安装、登录与模型配置**属于上游范畴，以官方文档为准：[opencode 官方文档](https://opencode.ai/docs/)。
> 本指南只覆盖它在网内的接入与托管方式（安装 opencode 后，运行一次 `opencode` 确认可用即可回来继续）。

### 1.4 最短路径（一键化总览）

| # | 在哪台机器 | 操作 | 预计 |
| --- | --- | --- | --- |
| 1 | Hub | `git clone` 本仓库后执行 `sudo bash scripts/hub/install.sh` | ~2 分钟 |
| 2 | Hub | 生成一次性加入密钥（§3，一条 curl） | ~5 秒 |
| 3 | 节点 | 打开 App → 首次向导按 §6 填写 →「保存并启动节点」；或一条脚本命令（§4.3） | ~1 分钟 |
| 4 | 控制端 | App「主控」页 →「同步节点（自动配置）」；或 `node node-ctl/cli.js visitors-config` 后启动 visitor | ~1 分钟 |

验收标准：全新机器从零到「节点在线且可被派发任务」≤ 10 分钟。升级时重复对应行即可（脚本幂等）。

## 2. 部署 Hub（公网服务器）

### 2.1 一键安装

```bash
git clone <本仓库地址> && cd opencode-mesh
sudo bash scripts/hub/install.sh
```

脚本按顺序完成：安装 Node.js（如缺）→ 落地 registry → 获取 frp 二进制（`frps` / `frpc`）→ **生成自签 TLS 证书（registry 走 HTTPS，客户端按指纹钉扎）** → 生成配置与随机密钥（含加入密钥 TTL、审计日志路径）→ 创建最小权限服务用户并注册 systemd 服务 → 放行防火墙（firewalld 如启用）。网络受限无法下载 frp 时，可先下载 frp 压缩包到服务器，用 `FRP_LOCAL_ZIP=/path/to/frp_linux_amd64.tar.gz sudo -E bash scripts/hub/install.sh` 重跑；暂不需要 TLS 时可用 `ENABLE_TLS=0 sudo -E bash scripts/hub/install.sh` 禁用。

### 2.2 配置字段（/etc/opencode-mesh/registry.env）

安装后按需检查，**保留已有密钥与数据（脚本幂等）**：

| 变量 | 含义 | 怎么设置 | 默认 |
| --- | --- | --- | --- |
| `REGISTRY_PORT` | 注册中心端口 | 一般不改 | `18080` |
| `REGISTRY_ADMIN_TOKEN` | 所有者密钥（应急与兼容用途） | 安装时自动生成；仅在 Hub 本地使用，勿外发 | 自动 |
| `REGISTRY_FRPS_ADDR` | Hub 对外地址（节点与控制端据此连接 frps） | 脚本尝试自动探测公网 IP；显示 `PLEASE_SET_HUB_PUBLIC_IP` 时**须手动改为公网 IP 或域名** | 需确认 |
| `REGISTRY_FRPS_PORT` | frp 控制口 | 一般不改 | `17000` |
| `REGISTRY_FRP_TOKEN` | frps 认证 token | 自动生成 | 自动 |
| `REGISTRY_PORT_START/END` | 主控侧回环端口分配区间（仅控制端本机使用，**无需公网放行**） | 一般不改 | `14100` / `19998` |
| `REGISTRY_DATA` | 注册数据文件路径 | 一般不改 | `/var/lib/opencode-mesh/data.json` |
| `REGISTRY_TLS_CERT` / `REGISTRY_TLS_KEY` | 自签证书与私钥路径（存在即启用 HTTPS，客户端按指纹钉扎） | 安装时自动生成并写入 | 自动 |
| `REGISTRY_AUDIT_LOG` | 审计日志（注册/吊销/改名/密钥签发/鉴权失败） | 一般不改 | `/var/log/opencode-mesh/audit.log` |
| `REGISTRY_JOIN_KEY_TTL_HOURS` | 加入密钥有效期（小时，`0` = 不过期；仅约束新注册，恢复不受限） | 按需调整 | `72` |

### 2.3 云安全组

放行 `18080/tcp`（registry）与 `17000/tcp`（frp）即可。**不要**放行 `14100` 以上的端口段——stcp 模式下节点服务零公网暴露，这些端口只存在于控制端本机回环。`22/tcp`（SSH）按运维需要自行保留。

### 2.4 验证

```bash
systemctl status opencode-mesh-registry opencode-mesh-frps   # 两个服务均应为 active
curl -sk https://127.0.0.1:18080/health                      # HTTPS：返回健康 JSON（含 tls 与 fingerprint）
# 未启用 TLS 时用：curl -s http://127.0.0.1:18080/health
```

`/health` 返回中的 `fingerprint` 应与安装输出的 TLS 指纹一致（SHA-256 hex）。

### 2.5 启用 TLS 的安全升级顺序（既有组网）

新装自动启用；对已有组网做一次性升级时，按以下顺序避免断联：

1. **全部设备更新代码**（`git pull`；本批客户端同时支持 HTTP 与钉扎 HTTPS，先更新不会破坏现状）
2. **Hub 重跑安装脚本**：`sudo bash scripts/hub/install.sh`（自动生成证书并启用 TLS，结尾打印指纹）
3. **各节点启用钉扎**：到该节点「设置」页，在「加入密钥」中粘贴 `密钥.指纹`（密钥用原来的即可）并保存 → 重启节点；脚本接入的设备更新 `node.json` 的 `hub.fingerprint`（或 `join.sh/join.ps1` 直接粘贴组合串重跑）
4. **控制端**：「同步节点」重新拉取并写入指纹（或重新执行 `visitors-config`）
5. 验证：节点在线、派发正常；`npm` 侧如有异常参考第 10 节排查

回退：`ENABLE_TLS=0 sudo -E bash scripts/hub/install.sh` 并删除 `registry.env` 中的 TLS 两行后重启；各设备清空 `fingerprint` 字段。

## 3. 获取加入密钥（入网凭据）——按步骤操作

> 加入密钥是"新设备入网"的**一次性**凭据：默认 **72 小时**有效（可由 Hub 的 `REGISTRY_JOIN_KEY_TTL_HOURS` 调整），**一拍一用**。
> 启用 TLS 的 Hub 返回的是「`密钥.指纹`」组合串（例：`3f2a…9e.f072…4b`），粘贴时**整串使用**即可——节点会自动拆分并把指纹用于证书钉扎，无需额外配置。

两种获取方式任选其一：

### 方式 A：在 Hub 服务器上生成（最直接）

1. SSH 登录你的 Hub 服务器：
   ```bash
   ssh <你的服务器用户>@<Hub公网IP>
   ```
2. 读取管理员密钥（仅在本机使用，勿外发；把输出暂存为 `<ADMIN_TOKEN>`）：
   ```bash
   grep '^REGISTRY_ADMIN_TOKEN=' /etc/opencode-mesh/registry.env | cut -d= -f2
   ```
3. 生成加入密钥（把 `<ADMIN_TOKEN>` 替换为上一步输出；`curl` 加了 `-k` 以接受自签证书；未启用 TLS 的旧 Hub 把 `https` 换回 `http` 并去掉 `-k`）：
   ```bash
   curl -sk -X POST https://127.0.0.1:18080/admin/keys \
     -H "X-Admin-Token: <ADMIN_TOKEN>" -H 'Content-Type: application/json' \
     -d '{"count":1}'
   ```
4. 从返回 JSON 的 `keys` 数组取出密钥（`count` 可一次生成多个，上限 20，适合批量接入备用）。
5. 把完整串（含 `.指纹` 后缀）交给待接入设备的操作者；每台设备消耗一个，过期自动失效。

### 方式 B：在任一已入网设备上生成（平权模型）

1. 在该设备上读取**本节点 token**（心跳与管理凭据）：
   - Windows：打开 `node-agent\data\state.json`，取 `token` 字段
   - Linux：打开 `node-agent/data/state.json`，取 `token` 字段
2. 调用 Hub 的同一接口（把 `<HUB>` 换成 Hub 公网地址、`<TOKEN>` 换成上一步的值）：
   ```bash
   curl -sk -X POST https://<HUB>:18080/admin/keys \
     -H "X-Node-Token: <TOKEN>" -H 'Content-Type: application/json' \
     -d '{"count":1}'
   ```
3. 其余同方式 A 的第 4–5 步。

> 平权模型：无固定"管理员"——任一已注册节点都可以生成/吊销；所有签发、注册与吊销操作都写入 Hub 审计日志（`/var/log/opencode-mesh/audit.log`），便于事后追溯。

## 4. 接入节点

### 4.1 先准备三样信息（每一来源都写明）

#### ① Hub 地址（及端口）

Hub 服务器的**公网地址**（IP 或域名），默认端口 `18080`。三个来源任选其一：

1. **部署 Hub 的人**：安装完成时 `install.sh` 会输出地址；或让对方直接告诉你
2. **Hub 服务器上查看**（SSH 登录后执行）：
   ```bash
   grep -E '^REGISTRY_FRPS_ADDR=|^REGISTRY_PORT=' /etc/opencode-mesh/registry.env
   ```
   （`REGISTRY_FRPS_ADDR` 即对外可用的地址）
3. **任一已入网设备**：打开 App →「设置」页 →「Hub 连接」区域，地址与端口即为所求

#### ② 加入密钥

一次性凭据，获取方式见上文 **§3**（两条路径的逐条命令已写明）。启用 TLS 时形如 `密钥.指纹`，**整串粘贴**。

#### ③ 网络统一的 opencode 密码

- **规则**：全网所有节点使用**同一个**密码（≥8 位）。它保护每台设备上的 opencode API——派发任务、读取会话都需通过它认证
- **全新网络（第一台设备）**：由**你自己设定**一个强密码（向导会要求必填，不再自动生成）
- **加入既有网络**：向网络管理员（或任一已入网设备的操作者）索取**现有统一密码**并如实填写；填错会导致从控制端派发任务时 401
- **修改**：任一已入网设备 →「设置」页 →「opencode」行 **⚙ 修改密码**（需先输入原密码验证；多节点网络请逐台同步修改）

#### 其他前置

- 已安装 opencode（[官方文档](https://opencode.ai/docs/)），命令 `opencode` 可用
- 已安装 Node.js 18+
- 无需准备 frpc：App 与脚本会自动获取；受限网络可手动下载 [frp releases](https://github.com/fatedier/frp/releases)，把 `frpc`（Windows 为 `frpc.exe`）放入 `node-agent/bin/`

### 4.2 方式 A：App（图形界面，推荐）

1. 按 §7 安装并启动 App；未配置设备会**自动弹出首次配置向导**（点过「稍后配置」则到「设置」页填写）
2. 按 §6 字段说明依次填写：节点名、Hub 地址 / 端口、加入密钥、opencode 端口与密码、agent 端口
3. 点击「保存并启动节点」
4. 「节点状态」应显示 `agent 运行中（PID …）· 已注册（stcp …）`
5. 验证：任一控制端「主控」页点「同步节点」，节点卡片出现且「在线」

### 4.3 方式 B：脚本（headless / 无图形环境）

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\node\join.ps1 -HubAddress <Hub地址> -JoinKey <KEY>
```

Linux（bash）：

```bash
bash scripts/node/join.sh --hub <Hub地址> --key <KEY>
```

| 参数（POSIX 同名） | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `-HubAddress` / `--hub` | 是 | — | Hub 公网 IP 或域名 |
| `-JoinKey` / `--key` | 是 | — | 一次性加入密钥（可含指纹：`密钥.指纹`，自动拆分并启用钉扎） |
| `-HubPort` / `--hub-port` | 否 | `18080` | registry 端口 |
| `-NodeName` / `--name` | 否 | 主机名小写 | 显示名（全网唯一） |
| `-OpencodePort` / `--oc-port` | 否 | `4096` | 本机 opencode serve 端口 |
| `-OpencodePassword` / `--oc-password` | 否* | — | **网络统一的 opencode 密码**（≥8 位）。加入既有网络时**必须**与其它设备一致；省略则自动生成随机密码并输出告警（仅适用于全新网络首台设备） |
| `-AgentPort` / `--agent-port` | 否 | `41999` | agent 受控 API 端口（本机回环） |
| `-FrpVersion` / `--frp-version` | 否 | 最新版 | 指定 frp 版本（网络受限时固定版本） |
| `-FrpLocalZip` / `--frp-local-zip` | 否 | — | 本地 frp 压缩包（离线环境） |

脚本会：获取 frpc（如缺）→ 使用 `-OpencodePassword`（未提供则生成随机并告警）→ 写入 `node-agent/node.json` → 后台启动 agent → 输出日志尾部。密码已写入本地配置，用于控制端编排，请妥善保存。

### 4.4 接入更多节点

对每台新设备重复 §3 生成密钥 + §4.2/4.3 接入即可。密钥一拍一用；泄露或设备遗失时经 `/admin/revoke` 吊销。

### 4.5 节点开机自启（headless / 服务器）

- Windows：见 §7.4（启动文件夹方式）
- Linux（systemd 示例）：

```ini
# /etc/systemd/system/opencode-mesh-agent.service
[Unit]
Description=opencode-mesh node agent
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=<仓库根>/node-agent
ExecStart=/usr/bin/env node agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 5. 配置控制端

控制端是发起操作的设备（App / CLI / opencode agent / Telegram），可与某节点同机。

### 5.1 App

1. 「设置」页填写一次 Hub 连接（同时写入主控配置）
2. 「主控」页 →「同步节点（自动配置）」：从 registry 拉取节点、自动生成并启动隧道（visitor 全自动运行）
3. 节点卡片即可启动 / 停止 / 重启各节点 opencode；本机回环端口按分配结果（自 `14100` 起）自动绑定

### 5.2 CLI（node-ctl）

```bash
node node-ctl/cli.js list                 # 节点列表与在线状态
node node-ctl/cli.js visitors-config      # 生成主控侧 frpc visitors 配置
node node-ctl/cli.js start|stop|restart <node>
node node-ctl/cli.js dispatch <node> "任务内容"   # 按消息协议派发（信封+回执）
```

配置为 `node-ctl/nodes.json`（含 Hub 连接与节点凭据；可用 App「设置」页「导出到剪贴板 / 从剪贴板导入」在设备间迁移）。

### 5.3 opencode 集成（fleet / node-ctl MCP）

- 主控 App「主控」页可生成 fleet MCP 配置片段；更推荐用「设置」页「MCP 集成」一键写入 node-ctl（见 §5.5），在 opencode 内直接编排多节点（配置字段格式以 [opencode 官方文档](https://opencode.ai/docs/) 为准）
- 设备间任务遵循 [消息协议 v1](PROTOCOL.md)；各节点需加载协作约定文件（`configs/agent-mesh-instructions.md`）

### 5.4 Telegram（可选）

1. 在 Telegram 中找 **@BotFather** → `/newbot` → 按提示取名 → 得到 bot token
2. App「设置」页 →「Bot Token 轮换」→ 粘贴 token →「更新并重启」
3. Bot 配置与日志位于 `%APPDATA%\opencode-telegram-bot\`（Windows）；网络环境需要代理时，在同一目录 `.env` 中配置 `TELEGRAM_PROXY_URL`（App 本机页「代理」行显示其连通状态）
4. 如 token 曾外露：BotFather `/revoke` 换新，再回到第 2 步
5. 手机使用：向 Bot 发消息 → 由控制端 opencode 处理 → 经 MCP / CLI 下发到目标节点 → 回执返回

### 5.5 MCP 集成

> **只配主控**：纯节点设备**无需任何 MCP**（节点的 opencode 只"被派发"）。只有当某台设备需要"用它的 opencode 指挥其它设备"（主控 / 控制端 / Telegram Bot 所在设备）时，才需要接入 MCP。

App「设置」页内置 **MCP 集成** 卡片，步骤：

1. 先点「同步节点（自动配置）」
2. 点 **「写入/更新 MCP 配置」**——自动定位本机 opencode 配置（`$OPENCODE_CONFIG` → `~/.config/opencode/opencode.jsonc`），**保注释、保格式**地写入 `mcp.node-ctl`；写入前自动备份（`*.mesh-bak-<时间>`），校验失败自动回滚
3. **重启本机 opencode** 后生效（MCP 配置只在启动时读取）
4. 状态徽标：`已配置 ✓` / `路径失效（一键重写修复）` / `未配置` / `未找到（写入时自动创建）`

**手动路径兜底**：自动探测找不到时（自定义 `OPENCODE_CONFIG`、非常规目录），在卡片输入框填入实际路径再点「写入/更新」——路径会被记住，后续检测与修复优先使用。

**关于 fleet（为什么默认不装）**：

| | node-ctl MCP（项目自带） | opencode-fleet（第三方） |
| --- | --- | --- |
| 依赖 | 仓库内脚本，零第三方 | npm 第三方包（npx 拉取、版本锁定） |
| 密码 | 从加密存储解封，配置里**无明文** | `--password` **明文**写在配置里 |
| 能力 | 13 个工具：派发/回执、会话浏览、消息读取、权限列表与审批、中断、生命周期、健康检查 | 与其能力面重叠（独有 SSE 低延迟状态缓存，差异仅在毫秒级读延迟） |
| 维护 | 随项目版本走 | 上游独立演进 |

结论：**默认只写 node-ctl**，写入时自动移除旧 `fleet` 条目（含明文密码）；确有需要的用户可点「保留 fleet 写入」。

**版本迭代与配置漂移（注意事项）**：

- **路径漂移**：移动/重装 kit 或仓库后，配置中记录的 `mcp-server.js` 绝对路径可能失效 → 状态显示「路径失效」→ 点「写入/更新」一键修复
- **工具集升级**：MCP 工具随 `node-ctl/mcp-server.js` 更新而更新——路径不变则无需改配置，**重启 opencode** 即获得新工具集
- **迁移清理**：旧配置中的 `fleet` 明文条目会在一次「写入/更新」后移除；你自定义的其它 MCP 条目原样保留（注释与格式不受影响）
- **幂等与备份**：重复写入无额外改动；每次写入前生成时间戳备份，需要回退时把 `*.mesh-bak-*` 改名恢复即可
- **合并链覆盖**：若使用项目级 `opencode.json` 或企业托管配置且定义了同名键，可能覆盖全局写入——此时请按 [node-ctl/README](../node-ctl/README.md) 手工合并

## 6. 配置字段详解

> 本节覆盖首次向导与「设置」页出现的**全部可填写字段**。按顺序照做即可完成入网。

### 6.1 节点身份与接入

| 字段 | 是什么 | 怎么填 | 示例 / 默认 | 常见错误 |
| --- | --- | --- | --- | --- |
| **节点名** | 节点的显示名（可随时改，全网唯一） | 取易识别的名字；注册 id 另行自动分配且不可变 | `dev-node-2`；默认主机名小写 | 重名会被拒绝（409），换一个或先吊销占用方 |
| **Hub 地址** | registry 所在服务器地址 | 问 Hub 部署者要公网 IP 或域名（无域名用 IP） | `1.2.3.4` 或 `hub.example.com` | 填成内网 IP / 带 `http://` 前缀（只填主机名或 IP） |
| **Hub 端口** | registry 端口 | 与 Hub 的 `REGISTRY_PORT` 一致 | `18080` | 云安全组未放行该端口 |
| **加入密钥** | 一次性入网凭据 | 按 §3 生成；一拍一用 | 一串随机字符 | 已被使用 / 已吊销 → 重新生成 |

### 6.2 opencode 与 agent

| 字段 | 是什么 | 怎么填 | 示例 / 默认 | 常见错误 |
| --- | --- | --- | --- | --- |
| **opencode 端口** | 本机 opencode serve 的监听端口 | 保持默认即可（端口冲突时换 1024–65535 内的空闲端口） | `4096` | 被其他程序占用（换端口或先停止占用程序） |
| **opencode 密码**（首次向导**必填**；日常修改：⚙ 齿轮入口） | 该节点 opencode 的访问密码；**全网统一**（派发需用同一密码访问所有节点） | 首次：向导中填写（≥8 位；加入既有网络须与其它设备一致，来源见 §4.1 ③）。修改：点「opencode」行右侧 ⚙ → 输入**原密码**（验证确认）+ 新密码（≥8 位）+ 确认 →「验证并保存」，agent 运行中即刻重启生效 | 无默认值（必填） | 原密码不正确 / 新密码过短 / 两次不一致均有提示；验证在节点本机完成；密码以加密形式存储（Windows DPAPI / Linux 密钥环，无密钥环时 600 权限回退） |
| **agent 端口** | node-agent 受控 API 端口（仅本机回环，经隧道供控制端访问） | 保持默认 | `41999` | 与 opencode 端口或其他服务冲突 |
| **frpc 路径** | 节点隧道转发程序 | 留空 = 自动在 `node-agent/bin/` 查找（推荐）；也可填绝对路径 | `bin/frpc.exe` | 文件缺失：脚本 / 向导会自动获取，受限网络按 §4.1 手动放置 |

> 多节点建议：各节点 opencode 密码**统一为同一个**（控制端编排使用同一密码访问所有节点；派发密码自动派生自本机节点密码，无需手工配置）。修改密码时请逐节点同步修改即可。

### 6.3 控制端配置备份（导出 / 导入）

控制端所需凭据全部自动派生（注册表操作走本机节点凭据、派发密码取本机节点密码），日常无需手工填写；以下操作仅用于**备份或迁移到新设备**（位于「设置」页「控制端配置备份」卡片）：

| 操作 | 说明 |
| --- | --- |
| **导出到剪贴板** | 把 Hub 连接、节点表与凭据打包到剪贴板——**含密码级敏感信息，请勿外发** |
| **从剪贴板导入** | 在新设备粘贴导入：写入控制端配置、自动同步节点；适合双控制端或更换设备 |

### 6.4 Bot Token 轮换（「设置」页）

| 字段 | 是什么 | 怎么填 | 示例 / 默认 | 常见错误 |
| --- | --- | --- | --- | --- |
| **Bot Token 轮换** | Telegram Bot 凭据 | 按 §5.4 从 @BotFather 获取；粘贴后「更新并重启」 | `123456:ABC-…` | token 泄露务必 `/revoke` 后轮换 |

### 6.5 端口与默认值（为什么是这些默认值）

| 端口 | 位置 | 默认值 | 默认值的来历 / 理由 | 如何修改 |
| --- | --- | --- | --- | --- |
| 注册中心 registry | Hub | `18080` | 高端非常用端口：避开 Web（80/8080）及常见服务；公网入向仅此端口与 frp 控制口，非常用端口降低被扫描命中的概率 | Hub 重跑 `install.sh` 前设置 `REGISTRY_PORT` |
| frp 控制口 frps | Hub | `17000` | frp 官方默认控制口是 7000，易与其它 frp 实例/既有服务冲突；本项目取 17000（17k 段极少占用） | 同 `FRPS_PORT`（重跑 install.sh） |
| 主控侧隧道回环口 | 控制端本机 | `14100–19998` 区间内按节点自动分配（每节点 2 个） | ① 仅在控制端 `127.0.0.1` 使用，不占公网；② 区间大（≈5900 个）可支持较多节点；③ 避开常用服务端口段 | Hub：`REGISTRY_PORT_START/END` |
| opencode serve | 节点 | `4096` | opencode 生态的常用默认端口，保留默认便于跨设备统一与排障 | 向导 /「设置」页「opencode 端口」（冲突时换空闲端口） |
| node-agent 控制 API | 节点 | `41999` | ① 只绑定 `127.0.0.1`，经 stcp 隧道供控制端按 token 调用，不向公网暴露；② 取 41xxx 高端不常见端口，几乎不与其它软件冲突；③ 与 opencode 端口分离，职责清晰 | 向导 /「设置」页「agent 端口」 |
| Hub SSH | Hub | `22` | 系统默认；仅运维使用，建议按安全清单加固（禁密码登录/禁 root 直登） | sshd 配置（按需） |

> 端口冲突处理：opencode / agent 端口冲突 → 换一个空闲端口（1024–65535）；Hub 端口冲突 → 改 `REGISTRY_PORT`/`FRPS_PORT` 后重跑 `install.sh`（幂等，数据保留）。

## 7. App 安装引导

### 7.1 Windows（源码方式）

1. 安装 [Node.js](https://nodejs.org/)（18+）与 Git
2. 获取仓库并安装依赖：

```powershell
git clone <本仓库地址>; cd opencode-mesh
cd node-app; npm install; npm start
```

3. （可选）快捷启动别名：将 `scripts\aliases\opencode-mesh.cmd` 复制到 `%APPDATA%\npm\`，之后任意位置输入 `opencode-mesh` 启动
4. 首次启动会弹出「快速配置」向导（见 §6）；暂不配置可点「稍后配置」，之后在「设置」页完成

### 7.2 Linux（便携包 / 源码）

- 便携包：解压 kit → 执行 `./start-app.sh`（内含 Electron，无需 npm install；`findRepoRoot` 自动定位仓库根）
- 源码：`cd node-app && npm install && npm start`（需图形环境；服务器无图形时用 `node-ctl` CLI + headless agent）

### 7.3 首次启动检查

「本机」页 →「一键诊断」：应全部为 ✓（远程连接可后续再配）。异常项会给出修复提示。

### 7.4 开机自启（Windows，可选）

目的：登录后自动拉起 Telegram Bot 与远程连接（不影响手动启动 App）。

1. 打开启动文件夹：`Win + R` → 输入 `shell:startup` → 回车
2. 方式一（推荐）：在其中创建**快捷方式**，指向仓库 `node-app\start-bot.vbs`
3. 方式二：复制 `start-bot.vbs` 到启动文件夹并重命名为 `opencode-telegram-bot.vbs`，然后执行一次（把路径改为你的仓库根）：

```powershell
setx OPENCODE_MESH_ROOT "C:\path\to\opencode-mesh"
```

4. 验证：「本机」页「开机自启」应显示「已配置」

## 8. 卸载引导

### 8.1 节点退网（从其他控制端移除）

1. 在**其他**已入网设备的 App →「主控」→ 目标节点卡片 →「移除」
2. Hub 会删除该节点的注册身份、token、stcp 密钥与已用加入密钥，并释放端口；本机主控删除节点配置、会话绑定并重建/清理 visitors 配置
3. 旧版 Hub 会自动回退到 `POST /admin/revoke`（建议 Hub 同步升级）
4. 被移除节点无法再用旧凭据接入；如需在本机彻底清除痕迹：停止节点后删除 `node-agent/data/` 与 `node-agent/node.json`
5. 本机节点不显示「移除」按钮；请在其他主控操作，或在本机使用「设置」→「重置身份」

> 审计日志只记录节点 id、端口与清理的密钥数量，不记录 token / stcp 密钥 / 密码。
>
> 被移除设备本地可能仍缓存其曾同步过的其他节点凭据，服务器无法远程清除；需要彻底隔离时请轮换网络统一密码或重建网络凭据。

### 8.2 控制端移除

1. 先在「主控」页移除不再需要的节点（或确认这些节点已从 Hub 撤销）
2. App →「设置」页 →「停用隧道」
3. 删除 `node-ctl/nodes.json` 与 `node-ctl/visitors.toml`（即清空本地凭据）

### 8.3 Hub 卸载（公网服务器）

```bash
systemctl disable --now opencode-mesh-registry opencode-mesh-frps
rm -rf /opt/opencode-mesh /etc/opencode-mesh /var/log/opencode-mesh
# 注册数据与密钥在 /var/lib/opencode-mesh —— 确认不再需要后再删除
```

### 8.4 App 本体卸载

- 退出 App（侧栏底部「退出应用」或托盘右键「退出应用」）
- 删除仓库目录（源码方式）或便携包目录（kit 方式）
- 移除别名（如安装）：删除 `%APPDATA%\npm\opencode-mesh.cmd`（Windows）或 `~/.local/bin/opencode-mesh` 软链（Linux）

### 8.5 凭据清理建议

吊销全部未使用的加入密钥与不再使用的节点；轮换 Telegram Bot token（§5.4）；Hub 重装会生成新密钥（旧节点需重新生成加入密钥接入）。

## 9. 升级

| 组件 | 操作 |
| --- | --- |
| Hub | `git pull` 后重跑 `sudo bash scripts/hub/install.sh`（幂等，密钥 / 数据保留） |

### 9.1 开发版（源码 clone）

> 数据文件（`node-agent/node.json`、`node-agent/data/`、`node-ctl/nodes.json`）不在 git 跟踪范围内：pull 不触碰、新代码按原路径读取。

```powershell
# 1. 处理本地改动（保证可快进合并）
git status --short
git add -A; git commit -m "checkpoint"     # 或 git stash push -u

# 2. 拉取（--ff-only 避免意外的合并提交）
git pull --ff-only

# 3. 仅当 node-app/package.json 有变化时需要（幂等，多跑无妨）
cd node-app; npm install

# 4. 重启 App（托盘退出 → 重新启动）
npm start
```

- 必须**整 App 重启**（`mesh-core.js` 为主进程代码）；agent 与隧道随 App 退出/启动自动重建
- 冲突锦囊：`git stash` → pull → `git stash pop`；真冲突按 Git 提示手动合并
- 服务器（headless 节点）：`git pull` 后重启 agent 进程即可
- 注意：开发环境检测到 `.git`，应用内「立即更新」会提示改用 git pull（两条通道互斥、语义一致）

### 9.2 发行版（便携包）

**应用内一键更新（推荐）**：App「设置」页 →「应用」→「版本与更新」→「检查更新」→「立即更新」——从 GitHub 拉取最新源码（运行时 + 界面）并覆盖，**数据文件不受影响**；完成后自动重启节点并重载界面。

- **引导期（v1.3.0 → v1.4.0）**：需手动安装一次新 kit——推荐**同目录覆盖**（把新包的 `app/` 与 `opencode-mesh/` 复制进旧目录），或把旧目录的 `node-agent/node.json`、`node-agent/data/`、`node-ctl/nodes.json` 拷贝到新目录。此后版本均可在应用内更新
- **涉及 Electron 壳（`app/`）变更的版本**：按发布说明下载新版 kit，覆盖 `app/`（不会触碰数据文件）
- 覆盖范围说明：更新只写代码文件（`node-agent/*.js`、`node-ctl/*.js`、`scripts/`、`docs/`、`node-app/` 界面源码等），不触碰节点配置/状态/主控节点表/隧道配置
- 网络受限环境：检查更新优先读取 GitHub tags Atom 源，失败回退 API；请求链为系统网络 → 可用代理 → curl 直连。下载走 codeload 直链，优先使用可达代理
- **v1.5.1 引导**：v1.5.0 及更早版本若「检查更新」报错，请手动 `git pull` 或替换一次应用包；升级后恢复应用内更新
- **v1.5.2 节点移除**：建议 Hub 同步升级以使用 `DELETE /admin/nodes` 与加入密钥清理；旧 Hub 自动回退到既有吊销接口

| 组件 | 操作（发行版） |
| --- | --- |
| 运行时 + 界面 | 应用内「立即更新」（或手动覆盖 `opencode-mesh/` 文件夹） |
| 协作约定 | 随应用内更新一并拉取（`configs/agent-mesh-instructions.md`），重启节点 opencode 会话后生效 |
| Electron 壳 | 仅壳变化的版本：下载新 kit 覆盖 `app/` |

## 10. 故障排查

| 现象 | 排查顺序 |
| --- | --- |
| 节点注册失败 401/403 | 加入密钥是否有效 / 已被使用 / 已吊销 / **已过期（默认 72 小时）** |
| 提示「certificate fingerprint mismatch」 | Hub 证书被重新生成（如删除 tls 目录后重跑 install.sh）或遭遇中间人：核对 Hub 上的指纹（install.sh 输出、`/health` 的 `fingerprint`），在设备端用 `密钥.新指纹` 重新保存；确认为中间人则立即停止使用并排查网络 |
| 旧客户端连不上 Hub（TLS 报错） | Hub 已启用 TLS，该设备客户端未更新：先 `git pull`，再按 §2.5 步骤 3 更新指纹 |
| 注册返回 409 | 该名称已被占用（全网唯一，防冒名）：换节点名，或先吊销占用方 |
| 改名后如何生效 | 保存后重启节点即自动同步显示名（注册 id 不变、无需新密钥）；控制端「同步节点」刷新列表 |
| 退出 App 后注册表未立即离线 | 需新版 Hub（含 `POST /offline`）；升级 Hub 后即时生效，旧版退化为约 150 秒心跳超时 |
| 退出 App 后节点仍在线 | 本机 App 版本较旧（旧版退出不清理进程）；升级后「退出 = 节点下线、关窗 = 托盘常驻」 |
| 节点`在线`但不可达 | agent 是否运行 → agent 日志（「设置」页）→ frpc 是否拉起；Hub 的 frps 是否 active |
| frpc 自动获取失败 | 网络受限：手动下载 [frp releases](https://github.com/fatedier/frp/releases)，把 frpc / frpc.exe 放入 `node-agent/bin/`，或脚本加 `-FrpLocalZip` / `--frp-local-zip` 重跑 |
| 修改 opencode 密码未生效 | 保存时按其提示重启本机 opencode；远程节点到主控页重启对应节点 |
| 控制端同步后端口不通 | 重新「同步节点」（自动清理并更新隧道）；检查回环端口占用（`14100+` 段） |
| Hub 更换地址后节点失联 | 各节点在「设置」页更新 Hub 地址并重启节点；控制端重新同步 |
| 手机端无响应 | 确认 Bot 所在控制端的 opencode（如 `4096`）在运行、Bot 进程存活（本机页状态卡） |
| `findRepoRoot` 报找不到仓库 | 用便携包 `start-app.sh` 启动，或设置环境变量 `OPENCODE_MESH_ROOT` 指向仓库根目录 |

## 11. 一键化速查

| 目的 | 一条命令 / 一步操作 |
| --- | --- |
| 部署 / 升级 Hub | `sudo bash scripts/hub/install.sh` |
| 生成加入密钥 | `curl -X POST http://127.0.0.1:18080/admin/keys -H "X-Admin-Token: <ADMIN>" -H "Content-Type: application/json" -d '{"count":1}'` |
| 接入节点（Windows） | `powershell -ExecutionPolicy Bypass -File scripts\node\join.ps1 -HubAddress <IP> -JoinKey <KEY>` |
| 接入节点（Linux） | `bash scripts/node/join.sh --hub <IP> --key <KEY>` |
| 控制端就绪 | App「主控」→「同步节点」；或 `node node-ctl/cli.js visitors-config` + 启动 visitor |
| 派发任务 | `node node-ctl/cli.js dispatch <node> "任务"` |
| 更新协作约定 | 各节点 `git pull` 后重启节点 opencode |
