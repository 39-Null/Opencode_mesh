# opencode-mesh

多设备 [opencode](https://opencode.ai) 协作网络：把多台装有 opencode 的机器组成一个可远程调度、互相协作的私有网络。手机或任意控制端可随时启停各设备的 opencode、下发任务并回收结果。

当前版本：**v1.5.3**（变更记录见 [CHANGELOG.md](CHANGELOG.md)）。

## 特性

- **脚本优先**：入网、隧道、启停、派发均由参数化脚本/CLI 完成；Electron App 是可选的图形层，headless 设备无需图形环境
- **自托管中继**：仅需一台有公网 IP 的服务器（无需域名），无任何第三方托管依赖
- **零公网暴露**：节点服务经 frp `stcp` 接入，节点自身不监听任何公网端口（仅出站连接）
- **平权组网**：任意设备注册入网后即可管理/邀请其他设备，无固定"管理员"角色
- **消息协议 v1**：设备间任务采用结构化信封 + 回执约定，弱模型亦可稳定解析（详见 [PROTOCOL.md](docs/PROTOCOL.md)）
- **可移植**：Windows / Linux 统一代码与配置格式，支持便携包分发

## 架构

```
控制端（本机 App / CLI / MCP / Telegram 可选）
        │  本机回环端口（stcp visitor）
        ▼
Hub（公网服务器：注册中心 + frps，管理密钥/节点注册/心跳/端口分配）
        ▲  stcp 隧道（出站）
        │
节点（node-agent：注册、frpc、opencode 生命周期、受控 API）
        │
        └─ opencode serve（各设备上的实际执行体）
```

- **Hub**：注册中心（`hub/registry`，Node 标准库）+ frps（公网唯一入口，两个端口：注册中心与控制端口）
- **节点**：`node-agent` 常驻进程，负责注册、心跳、隧道、按 token 鉴权的 opencode 启停接口
- **控制端**：`node-app`（单代码库多角色：本机/组网/主控）、`node-ctl`（CLI + MCP：远程启停 / 任务派发 / 权限审批）、Telegram Bot（可选）

**典型数据流**（完整时序图见 [设计文档 §3.1](docs/DESIGN.md)）：

- **入网**：节点 → registry 注册（一次性加入密钥）→ 分配 id / token / 隧道密钥 → frpc 出站建立 stcp 隧道 → 周期心跳
- **远程生命周期**：主控 → 本机 visitor 回环端口 → 隧道 → 节点 agent → 启停/查询本机 opencode
- **任务派发**：主控 opencode（node-ctl MCP）→ 同一隧道 → 节点 opencode 执行 → 回执块原路回收

公网入向仅 Hub 的 `17000`（frp）与 `18080`（registry）；其余全部为出站连接。

## 仓库结构

```
opencode-mesh/
├─ docs/            # 文档：设计 / 部署 / 使用 / 协议 / 待办
├─ node-app/        # 节点桌面应用（Electron）：本机诊断、组网、主控
├─ node-agent/      # 节点常驻代理：入网注册、frp 隧道、opencode 生命周期、受控 API
├─ node-ctl/        # 控制端工具：CLI + MCP（远程启停 / 任务派发 / 权限审批 / 会话浏览）
├─ hub/registry/    # 注册中心：加入密钥、注册、心跳、节点列表、吊销
├─ scripts/         # hub 安装（hub/）、节点加入（node/）、主控辅助（master/）、启动别名（aliases/）
└─ configs/         # 示例配置（真实配置与密钥均被 .gitignore 排除）
```

## 快速开始

三种角色，各自最短路径（完整步骤、每个配置字段的获取方式与示例见 [部署与运维指南](docs/DEPLOY.md)）：

| 角色 | 最短路径 |
| --- | --- |
| **Hub**（一台公网服务器） | `git clone` 后 `sudo bash scripts/hub/install.sh` → 生成一次性加入密钥 |
| **节点**（任意设备） | 打开 App → 首次向导按提示填写 →「保存并启动节点」；或脚本：`scripts\node\join.ps1`（Windows）/ `scripts/node/join.sh`（Linux） |
| **控制端** | App「主控」页 →「同步节点（自动配置）」→「MCP 集成 · 写入/更新」→ 重启本机 opencode；或 `node node-ctl/cli.js list` |

**开发运行**（源码方式，各设备独立安装依赖）：

```bash
git clone <本仓库地址> && cd opencode-mesh
cd node-app && npm install        # node_modules 不可跨平台/跨设备拷贝
npm start
```

**生产部署**（推荐）：参见 [部署与运维指南](docs/DEPLOY.md)。

**日常使用**：参见 [使用手册](docs/USAGE.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [设计文档](docs/DESIGN.md) | 架构、数据流/网络流、角色、配置格式、安全设计、路线图 |
| [部署与运维](docs/DEPLOY.md) | 架构与数据流、一键化部署、App 安装/卸载、配置字段逐项教学、升级、故障排查 |
| [使用手册](docs/USAGE.md) | App 各页说明、典型操作、CLI 参考、常见问题 |
| [消息协议](docs/PROTOCOL.md) | 设备间任务信封、回执块、澄清块与信任边界 |
| [版本记录](CHANGELOG.md) | 各版本新增、改进、修复与升级说明 |
| [待办与计划](docs/TODO.md) | 阶段性成果概要与后续计划 |

## 多设备代码同步（Git 工作流）

1. 设备 A：`git add -A && git commit -m "..." && git push`
2. 设备 B：`git pull`（如前端依赖有变，在 `node-app` 重新 `npm install`）
3. 注意：`node_modules/`、`dist-*/`、运行时状态与全部密钥（`node.json`/`state.json`/`nodes.json` 等）均被 `.gitignore` 排除——**代码同步 ≠ 配置同步**，组网配置请在各自设备上用 App 的「导出/导入」迁移

**首次克隆**：`git clone <本仓库地址>`。若网络环境对 GitHub 22 端口受限，可在 `~/.ssh/config` 中为 `github.com` 配置走 443：

```bash
mkdir -p ~/.ssh && cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName ssh.github.com
  Port 443
  User git
EOF
```

**Windows 认证**（密钥已装入 ssh-agent 时无需重复；重启后执行一次）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\aliases\github-auth.ps1
```

## 启动别名（可选）

仓库提供启动别名脚本（Windows：`scripts\aliases\opencode-mesh.cmd`；Linux：`scripts\aliases\opencode-mesh.sh`），安装到 PATH 后可用简短命令启动 App；命令名可自行重命名。

```powershell
# Windows：安装到 PATH
copy scripts\aliases\opencode-mesh.cmd "$env:APPDATA\npm\opencode-mesh.cmd"
```

```bash
# Linux：软链到 PATH 并授权
chmod +x scripts/aliases/opencode-mesh.sh
ln -s "$PWD/scripts/aliases/opencode-mesh.sh" ~/.local/bin/opencode-mesh
```

## 安全模型

- 节点 opencode 服务**零公网暴露**：仅 Hub 的注册端口与 frp 控制端口公开
- **registry HTTPS（自签）+ 客户端指纹钉扎**：指纹随加入密钥以 `密钥.指纹` 组合串分发，防路径嗅探与中间人
- 三层凭据：Hub 所有者密钥（应急/兼容）、一次性加入密钥（默认 72h 过期，可吊销）、节点 token（心跳与受控 API）
- 审计日志与降权服务：Hub 关键事件留痕；registry / frps 以专用非 root 用户运行；敏感配置文件权限自动收紧
- 统一修改各节点 opencode 密码后，保存时经回环接口重启本机 opencode 即刻生效；远程节点可在主控页重启
- 手机端建议为 Bot 单独轮换 token，不与上述凭据混用

## 路线图

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0–P2 | 设计冻结、仓库重构、本机管理面板、frp + agent + NodeCtl 端到端 | ✅ |
| P3 | Hub 部署脚本、stcp 零暴露、平权模型 | ✅ |
| P4 | 跨设备验收：第二节点入网、远程生命周期、任务派发回收、MCP 双节点编排、消息协议 v1 | ✅ |
| P5 | 文档规范化（README/部署/使用/协议）、Linux 便携包 | ✅（CI 待补） |
| P6 | Windows 便携包与版本发布、手机端实测、更多平台适配 | 🚧 |

## 许可证

[MIT](LICENSE)
