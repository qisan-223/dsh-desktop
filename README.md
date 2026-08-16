# DSH Desktop

把 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（DeepSeek Harness）封装为开箱即用的 Windows 桌面客户端：内置 dsh CLI 与独立 Node 运行时，双击即启动 Web UI，并支持**承接官方 dsh 更新（用户自主选择）**。

## 功能

- **免装 Node**：内置独立 Node 运行时与 npm CLI，目标机器无需预装任何运行时。
- **内置 dsh CLI**：完整打包 `@deepseek-ai/dsh` 及全部插件，离线可用。
- **一键启动**：双击即启动 `dsh web`，自动挑空闲端口，就绪后加载到原生窗口。
- **退出即清理**：退出应用自动结束 dsh 进程树，不留孤儿进程。
- **与 CLI 共享配置**：默认沿用 `~/.dsh`（可用 `DSH_HOME` 覆盖），已有会话/API Key 直接生效。
- **承接官方更新（自主选择）**：启动时自动检测官方 `@deepseek-ai/dsh` 新版本，仅提示不强制；用户可选「立即更新 / 跳过此版本 / 稍后」。更新采用用户目录 overlay + 原子切换，失败自动保留当前版本，可一键回退内置版。

## 系统要求

- Windows 10/11（x64）
- 无需预装 Node.js 或任何其他运行时

## 从源码构建

```powershell
pnpm install                 # 安装依赖（含原生模块 build）
pnpm run setup-electron      # 下载 electron 二进制（镜像见下）
pnpm run fetch-runtime       # 内置 node.exe + npm CLI 到 vendor/
pnpm run dev                 # 开发模式
pnpm run package:win         # 构建 NSIS + portable → dist/
```

网络受限时：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
# 或走本地代理：在 .npmrc 配置 proxy / https-proxy
```

## 架构

```
┌──────────────────────────────────────────────────────────┐
│  Electron 壳 (src/main/index.ts)                          │
│  · 单实例锁 / 窗口 / 菜单 / 生命周期                       │
│  · 官方更新 (updater.ts) → 用户同意后安装 overlay          │
│  · spawn 内置 node.exe 跑 dsh web                          │
└──────────────┬───────────────────────────────────────────┘
               │  node <dsh lib/bin.js> web --host 127.0.0.1 --port <port>
               ▼
        内置 node.exe + @deepseek-ai/dsh
        路径解析：用户目录 overlay > 内置包
        就绪后轮询 HTTP 200，加载到原生窗口
```

### 官方更新 overlay 机制

- overlay 目录：`<userData>/agent`（优先于内置包）。
- 检测：内置 npm 跑 `npm view @deepseek-ai/dsh version`。
- 安装：`npm install --prefix <userData>/agent-staging @deepseek-ai/dsh@<version>`，成功后原子切换。
- 回退：overlay 启动失败时一键回退到内置版。

## 目录结构

```
dsh-desktop/
├── src/
│   ├── main/
│   │   ├── index.ts             # 主进程（窗口/生命周期/更新流程/菜单）
│   │   ├── runtime/harness-runtime.ts  # 拉起 dsh web 的状态机
│   │   ├── updater.ts           # 官方更新引擎（overlay）
│   │   ├── security.ts          # 导航围栏/权限
│   │   └── security-policy.ts
│   ├── preload/index.ts         # 沙箱 preload
│   └── shared/contracts.ts
├── scripts/
│   ├── fetch-node.mjs           # 内置 node.exe
│   ├── fetch-npm.mjs            # 内置 npm CLI
│   └── after-pack.cjs           # 打包后恢复 npm 依赖
├── vendor/                      # 内置运行时（不入库）
├── electron-builder.yml
└── dist/                        # 构建产物（不入库）
```

## License

MIT。基于 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）。
