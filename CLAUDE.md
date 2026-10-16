# LingChain

VS Code 扩展 + LSP 服务器，为嵌入式 C 项目（Keil MDK / ARM Compiler）提供代码导航、补全和诊断。

## 技术栈

**VS Code 扩展 (TypeScript)**

- TypeScript 5.4（严格模式，ES2022，CommonJS）
- VS Code API ^1.85 / vscode-languageclient ^9.0
- LSP Server: vscode-languageserver ^9.0, web-tree-sitter ^0.22.6, node-sqlite3-wasm ^0.8, fast-xml-parser ^5.9

**MCP 服务器 (Python)**

- Python >=3.10, MCP SDK >=1.0, Hatch 构建系统
- pytest + pytest-mock 用于测试

**测试**

- Jest 29 + ts-jest（TypeScript 侧）
- pytest（Python 侧）

## 项目结构

```
vscode-extension/
├── scripts/                # bundle-extension.js（esbuild 打包客户端）
│                           # bundle-deps.js（把 server 产物 + 生产依赖闭包 stage 进 extension/server）
├── extension/src/          # VS Code 扩展客户端
│   ├── extension.ts        # 入口：启动 LSP 客户端、解析 server 模块与 armclang 配置
│   ├── keilProjectScanner  # Keil 项目扫描
│   └── statusBar           # 状态栏 UI
├── server/src/             # LSP 服务器（核心逻辑）
│   ├── server.ts           # 入口：LSP 请求分发、缓存目录、live 符号接线
│   ├── symbolIndex.ts      # SQLite 符号索引（files/symbols/usages）
│   ├── treeSitterExtractor # tree-sitter 解析（grammar 来自 tree-sitter-wasms）
│   ├── navigationProvider  # 定义/引用/悬停
│   ├── completionProvider  # 代码补全
│   ├── diagnosticsProvider # armclang 真实诊断
│   ├── armclangLocator.ts  # armclang 定位（配置/环境变量/注册表/常见路径/PATH）
│   ├── armclangArgs.ts     # --target/-mcpu 参数推导
│   └── keilProject.ts      # Keil .uvprojx 解析
mcp_server/                 # STM32 CMake MCP 服务器（Python）
docs/adr/                   # 架构决策记录
docs/agents/                # Agent 工作流文档
```

## 常用命令

```bash
# 编译（在 vscode-extension/ 下）
cd vscode-extension && npm run build          # 编译 extension + server 两个 workspace
cd vscode-extension && npm run test           # Jest（server + extension）

# 单独编译
cd vscode-extension/extension && npm run compile
cd vscode-extension/server && npm run compile

# VSIX 打包（自动 compile + esbuild 打包客户端 + stage server 依赖）
cd vscode-extension/extension && npm run package

# 安装 / 更新本地 VS Code 扩展（改代码后覆盖安装，需 Reload Window 生效）
cd vscode-extension/extension
npm run package
code --install-extension .\lingchain-embedded-c-0.1.0.vsix --force

# 卸载本地扩展
code --uninstall-extension lingchain.lingchain-embedded-c

# LSP 验证（详见下方命令输出；都不需要 VS Code GUI）
cd vscode-extension && node lsp_smoke_test.js [server.js]   # initialize 握手 + tree-sitter grammar 是否加载
cd vscode-extension && node lsp_e2e_test.js [server.js]     # 端到端：临时 Keil 工程 → 索引 → 各 LSP 请求断言

# 排查真实工程为何无法跳转：解析编译上下文 → 真实索引 → 报告 DB 统计与逐文件错误
cd vscode-extension && node lsp_diagnose.js "<工程目录或 .uvprojx>" [server.js] [--timeout-ms 300000]

# Python MCP 服务器
cd mcp_server && pip install -e ".[dev]"       # 安装（含开发依赖）
pytest                                         # 运行测试
```

## 代码规范

**MUST**

- TypeScript 严格模式，所有文件使用 `strict: true`
- 使用 ES2022 特性（顶层 await、Array.at() 等）
- 为所有公共 API 添加 JSDoc 注释
- 测试文件与源文件同目录，命名为 `*.test.ts`
- 使用 `// ── Section Name ──` 分隔符组织代码段

**SHOULD**

- 源文件不超过 300 行，超过时拆分模块
- 使用 `const` 优先，避免 `let`，禁止 `var`
- 类名 PascalCase，函数/变量 camelCase，常量 UPPER_SNAKE_CASE
- import 使用具名导入，避免 `import *`
- Python 代码遵循 PEP 8，使用 type hints

## 架构要点

- 扩展客户端（extension）保持轻量，仅负责 UI 和 LSP 客户端启动；发布时由 esbuild 打成单文件，无 node_modules 依赖
- 服务器（server）承载所有核心逻辑：索引、解析、补全、诊断
- 符号索引持久化在工程目录 `<工程根>\.lingchain\<工程名>-<哈希>.db`（每个 Keil 工程一个库，工程根由源文件公共祖先推断；files/symbols/usages 三表，schema 版本变更时自动重建）；体积较大（HAL 工程约 70 MB），若工程在 OneDrive 等同步盘中会被同步
- tree-sitter 语法来自 `tree-sitter-wasms` 的 `tree-sitter-c.wasm`；未加载时退回正则抽取（日志会警告）
- 打开文档的实时符号（含未保存编辑）优先于持久索引
- armclang 由 `armclangLocator` 定位，`--target`/`-mcpu` 由 `armclangArgs` 统一推导，诊断用 `-fsyntax-only`（不写 .o）
- Phase 1: 导航+补全；Phase 2: armclang 真实诊断
- 详见 `docs/adr/` 和 `CONTEXT.md`

## Agent skills

### Issue tracker

Issues live as GitHub issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at repo root. See `docs/agents/domain.md`.
