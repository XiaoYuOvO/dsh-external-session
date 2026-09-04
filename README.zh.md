# dsh-external-session

DSH 项目外部会话持久化插件（Host 平面）：把**属于指定项目**的会话日志原生存放到**项目仓库内**（默认建议 `<项目>/.dsh-sessions/`），随 git clone/push 跨端同步；其它 workspace 的会话行为完全不变。

## 目录

- [它做什么](#它做什么)
- [Spike 结论：路线 A 可行](#spike-结论路线-a-可行)
- [架构](#架构)
- [安装](#安装)
- [配置](#配置)
- [命令与工具](#命令与工具)
- [git 同步纪律（必读）](#git-同步纪律必读)
- [硬性约束与可逆卸载](#硬性约束与可逆卸载)
- [与其它会话工具的互操作](#与其它会话工具的互操作)
- [自测记录（§9 验收清单）](#自测记录9-验收清单)
- [已知取舍](#已知取舍)

## 它做什么

DSH 会话持久化默认只有一个全局根 `$DSH_HOME/sessions`，所有 workspace 的会话按 cwd 编码的子目录组织其下，日志是**多 zstd frame 追加写的 JSONL**。

本插件**替换**默认 `@deepseek-ai/dsh-session-persistence-jsonl` 后端，唯一新增的决策点是**按会话 cwd 选存储根**：

```
rootFor(cwd):
    cwd 命中某 external 条目（位于其 cwdPrefix 下）→ 该条目 root
    否则                                         → internalRoot（默认 $DSH_HOME/sessions）
```

于是：

1. 在属于"外部项目"的 cwd 下新建会话 → 日志落该项目的 `.dsh-sessions/`，内部 `sessions` 下不出现该项目目录。
2. 外部根中的会话（含 git 同步来的）重启后自动出现在会话列表（等价"导入"，无需手工复制），可续聊、可 fork。
3. fork 子会话自动落同一外部根（`SessionStore.fork()` 继承父 cwd，路由按 cwd 生效，无需劫持 fork）。
4. 外部文件与内置 jsonl 后端保持相同日志协议，可互读（旧布局见自测 §5；portable 布局由本插件读取）。

## Spike 结论：路线 A 可行

按 §5 的 spike 步骤核对本机部署（`@deepseek-ai/dsh-*` 全部 `0.1.1-rc.2`）：

1. `session-persistence-jsonl` 行位于 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml`（**bundle 层**），行 id = `session-persistence-jsonl`，config 为 `{ root: !!js dshHomePath('sessions') }`。
2. profile 的 `cordis.patch.yml` 在**所有 bundle 层之后**应用，且本 profile 已实测使用过 `disabled: true`（`dsh-at-file`）与 `insert`（多行）两种补丁能力。
3. `JsonlSessionPersistence extends SessionPersistence extends Cordis Service`，`super(ctx, "sessionPersistence")` —— 单 provider 语义。禁用默认行 + `insert` 本后端 = 进程内**恰好一个** `sessionPersistence` 提供者。
4. `session-query` 的 `SessionCorpus` 通过 `ctx.inject(["sessionPersistence"], …)` **可选**绑定，路由后端的 `list()` 扫外部根即可让外部会话自动进列表，前端零改动。
5. 所有 peer 依赖（`@deepseek-ai/{cordis,schemastery,dsh-session,dsh-session-persistence,dsh-tools}`）均已提升到 `profiles/node_modules`，运行时可解析。

**结论：走路线 A（路由持久化后端）。** 默认 jsonl 行的 `disabled` 只发生在 profile patch（本包 `cordis.patch.yml`），可逆。

## 架构

`lib/index.js` 内的 `RoutedJsonlPersistence` 是 stock jsonl 后端的**忠实复制**，仅在两处插入路由：

- `rootFor(cwd)`：cwd → root 的唯一决策点；`locate/create/append/materialize/repair` 全部以它取代原固定 `this.root`。

## 磁盘布局与跨 clone

外部项目使用与 clone 路径无关的相对目录 key：

```text
<project>/.dsh-sessions/--rel-<encoded-relative-cwd>--/<sessionId>/session.jsonl.zstd
```

例如项目根下的 `src` 会写入 `--rel-src--`，项目根本身写入 `--rel-root--`。header 中仍保留 DSH 原生绝对 `cwd`，读取时按当前 external 条目的 `cwdPrefix` 映射到当前 clone 的路径；事件内容和 session id 不变。

旧版本按绝对 cwd 生成的目录仍会读取，并在能识别项目后缀时映射到当前 clone。新写入统一使用 portable key。portable 布局依赖本插件的路由后端，不能由未加载本插件的 stock jsonl 后端直接扫描；旧绝对布局仍保持 stock 互读。


磁盘布局 / header 行 / 事件序列化 / 多帧 zstd 追加 / 截断尾帧恢复 / 崩溃截断修复，与 stock 后端保持相同日志协议；portable 目录只改变项目目录 key，由本插件在扫描时解码和重映射。

## 安装

本插件可直接从 GitHub 安装，也可以使用本地 link。GitHub 安装会把包加入 `web` profile，并自动识别包内的 `dsh.bundle` 声明：

```powershell
dsh plugin --profile web add github:XiaoYuOvO/dsh-external-session
```

也可以在 `profiles/web` 目录执行本地安装：

```powershell
pnpm add "link:../../plugins/dsh-external-session"
```

安装后需要在 profile patch 中配置要路由的项目：

2. **bundles**：把 `"dsh-external-session"` 追加进 `profiles/web/package.json` 的 `dsh.profile.bundles` 数组。

3. **external 配置**（`profiles/web/cordis.patch.yml`，追加）：
   ```yaml
   - id: dsh-external-session
     config:
       external:
         - id: rsprojects-dsh
           cwdPrefix: 'H:\RSProjects\deepseek-harness-desktop'
           root: 'H:\RSProjects\deepseek-harness-desktop\.dsh-sessions'
   ```

4. **重启宿主**生效（Host half 改动不热更）。

   > `link:` 依赖在本机是 junction 指向插件源码；本包是 ESM、依赖 `@deepseek-ai/*` peer，解析链为 `plugins/dsh-external-session/node_modules/@deepseek-ai` → `profiles/node_modules/@deepseek-ai`（junction）。若 pnpm 因 github 源依赖被沙箱拦截无法 `pnpm install`，需手工建这两个 junction（见下），或在网络可用时完整 `pnpm install` 让 pnpm 处理 peer。
   > ```powershell
   > New-Item -ItemType Junction -Path 'profiles/web/node_modules/dsh-external-session' -Target 'G:\Deepseek Harness Desktop\data\dsh\plugins\dsh-external-session'
   > New-Item -ItemType Junction -Path 'G:\Deepseek Harness Desktop\data\dsh\plugins\dsh-external-session\node_modules\@deepseek-ai' -Target 'G:\Deepseek Harness Desktop\data\dsh\profiles\node_modules\@deepseek-ai'
   > ```

> 本包自带的 `cordis.patch.yml` 只做两件事：`disabled: true` 关掉默认 `session-persistence-jsonl` 行，并 `insert` 本后端行（无 external 配置，默认纯内部根）。external 条目是用户特定配置，放 profile patch。

## 配置

```yaml
- id: dsh-external-session
  name: dsh-external-session
  config:
    enabled: true            # false = 不路由，纯内部根（仍提供持久化，等价 stock 行为）
    internalRoot: ''         # 空 = $DSH_HOME/sessions
    external:                # 外部项目条目（按序匹配，首个命中生效）
      - id: rsprojects-dsh   # 展示名，[A-Za-z0-9._-]
        cwdPrefix: 'H:\RSProjects\deepseek-harness-desktop'   # 项目根绝对路径
        root: 'H:\RSProjects\deepseek-harness-desktop\.dsh-sessions'  # 外部目录绝对路径
    packChunks: true
    compression: zstd        # 'zstd' | 'none'
    registerCommand: true    # 注册 /external-session
    registerTools: true      # 注册 external_session_* 工具
    registerWeb: true        # 注册 /external-session/* HTTP 路由（Client 导入/查询用）
    listCacheTtlMs: 1000     # list() 目录扫描缓存 TTL（新会话落盘时立即失效）
```

安全校验（失败关闭）：

- 路径必须绝对；`cwdPrefix` / `root` / `internalRoot` 已存在部分若经符号链接解析到词法路径之外 → `PATH_UNSAFE` 拒绝。
- external 条目 `id` 唯一；`root` 路径不得与其它条目或 `internalRoot` 撞车。

## 命令与工具

### `/external-session`（命令）

| 子命令 | 作用 | 只读 |
| --- | --- | --- |
| `status` | 列出每个 root、路径、会话数 | ✅ |
| `list [<rootId>]` | 列外部会话（或全部） | ✅ |
| `move <sessionId> <internal\|rootId>` | 内部↔外部迁移 | ❌ 确认门 |
| `git-status <rootId>` | 外部 root 仓库未提交/未跟踪统计 | ✅ |
| `help` | 帮助 | ✅ |

### 工具

- `external_session_status`（只读）：报告各 root 与会话数。
- `external_session_move`（确认门）：按 id 迁移非 live 会话。

**确认门**：`move` 写操作经 `userQuestions`（web UI）确认；无回答者时抛 `NO_PROVIDER` **失败关闭**，绝不静默执行。只读操作不询问。

**审计**：每次 materialize（路由决策）/ move / 异常输出一行结构化日志（仅标量）：

```
[dsh-external-session] {"event":"move-done","sessionId":"...","from":"...","to":"..."}
```

## Client 端功能

浏览器侧（`lib/client.js`，经 `dsh.client` 声明加载）提供两个界面：

1. **导入外部项目**：按钮位于设置面板标题栏的动作区，使用插件内部复制的 DSH browse 交互（目录数据仍由公开的 `workspaces.listDirectory()` / `createDirectory()` 提供），不调用 native-only 的 `pickDirectory()`；选择后注册工作区，并优先打开该项目已有的外部会话。没有历史会话时，会创建并打开新的外部会话。
2. **外部标记**：按会话的实际持久化根目录判断（而非仅按 cwd），显示在 Header 左侧 Agent 控件之后；绿色「外部」徽标加宽加高以提升辨识度。

配套 Host HTTP 路由（`registerWeb`）：

| 方法/路径 | 作用 |
| --- | --- |
| `GET /external-session/config` | 列出 internalRoot + 全部外部条目（含 dynamic 标记） |
| `POST /external-session/import` `{path}` | 导入项目文件夹为外部条目（`root` 默认 `<path>/.dsh-sessions`） |
| `GET /external-session/sessions?entryId=` | 列出一个外部项目条目中的已有会话，供导入后恢复最近会话 |
| `GET /external-session/external?sessionId=` | 按会话实际存储根判断是否外部（解决同一 cwd 下内部/外部会话误判）；保留 `cwd` 查询供兼容。

> 侧边栏会话列表（`sidebar.workspaces`）由内置 WorkspaceBrowser 独占渲染，当前没有公开的列表项级 Slot，因此插件不改写宿主列表 DOM。Header 徽标按 sessionId 查询实际日志文件所在根目录；同一 cwd 下的内部会话不会因 cwd 相同而误标为外部。
## git 同步纪律（必读）

外部根默认落在**项目仓库内**（`.dsh-sessions/`），`.gitignore` 不忽略它，git clone/push 即随之同步。

⚠️ **会话文件 = 内置同格式 `.zstd` 二进制追加日志，git 无法自动 merge。** 必须遵守：

1. **同一外部会话不同时在两台机器开。** 二进制追加日志无法三方合并，同时写 = 冲突损坏。
2. **提交前正常结束会话**（turn 完整、帧完整），pull 前先 commit。
3. **跨 clone**：新 portable 布局不要求两端 checkout 到相同绝对路径。请确保各端都把 `.dsh-sessions/` 纳入 git，且项目条目指向当前 clone 根；读取时 header 的旧绝对 `cwd` 会映射为当前根下的相对目录。旧版本绝对路径布局也会尝试按项目目录名和路径后缀兼容映射，但无法识别项目对应关系的旧目录需要手动迁移。
4. 本插件**不做** commit/push（把 git 留给用户）；`git-status` 只读提示未提交/落后。

### 可选互操作（不实现）

若另装 `dsh-session-sync`（PerryLink），可将其 `sessionRoot`/仓库指向外部根，获得冲突"两边保留"合并。本插件自身不做自研 merge。

## 硬性约束与可逆卸载

- **不改 DSH 运行时源码、不改内置 preset**；默认 jsonl 行的 `disabled` 只发生在 profile patch。
- 布局/写协议与 stock jsonl 一致（互读优先），无第二套私有格式。
- 命令/工具/审计随 fiber 释放，停止/卸载零残留。
- **可逆卸载**：从 `cordis.patch.yml` 移除 `session-persistence-jsonl: disabled` 与 `dsh-external-session` insert，并从 bundles/依赖移除本包，重启即回到 stock 后端；内部会话与外部已有文件均完好。
- 不序列化 live 对象；审计只含标量。
- 性能：`list()` 目录扫描带 TTL 缓存，新会话落盘/迁移时立即失效，避免每帧刷新。

## 自测记录（§9 验收清单）
`node test/run-tests.mjs`（Node ≥22 直跑，无真实宿主）结果 **48 passed, 0 failed**：

| §9 项 | 覆盖 | 结果 |
| --- | --- | --- |
| 1 外部创建 | 外部 cwd 会话落外部根、内部根无该项目目录 | ✅ |
| 2 内部不受影响 | 其它 workspace 会话仍落内部根 | ✅ |
| 3 重启恢复 | 全新 backend 实例 list 到外部+内部会话 | ✅ |
| 4 导入/跨端 | 外部根中的日志自动进列表（"外部即导入"） | ✅ |
| 5 外部分支 | fork 继承 cwd → 路由落同一外部根（实测 `test/fork-inherit.mjs`：真实 SessionStore.fork 后子会话 cwd=父 cwd、rootFor 同根） | ✅ |
| 6 迁移 | move 内部↔外部双向、事件完整、源清理 | ✅ |
| 7 格式互读 | 旧绝对布局由 stock jsonl 后端 `list`/`loadStored` 读取；portable 布局由本插件跨 clone 读取 | ✅ |
| 8 并发/容错 | 截断尾帧被容忍、已确认事件不丢、返回 tornMarker | ✅ |
| 9 可逆卸载 | 移除补丁即回 stock 后端、文件完好（构造性） | ✅（见卸载说明） |

测试同时覆盖：路径编码（`--H-RSProjects-deepseek-harness-desktop--`）、header 往返、`scanZstdFrames` 帧扫描、非自然 move 后追加不产生分叉文件、live 会话 move 被拒、未知 rootId 抛错。

## 已知取舍

- **`move` 与 cwd 路由的语义**：路由由 cwd 派生，`move` 是"物理搬迁 + 位置缓存"——搬迁后追加跟随会话实际位置（不产生分叉文件），读取端只校验 id + 项目目录名（不要求文件必须在 `rootFor(cwd)` 处）。`move` 主要用于**配置变更后把存量会话搬到新 root 对齐**。
- **materialize 用 `rename` 发布**（未用 stock 后端的 Win32 `MoveFileExW` write-through + koffi 原生路径）：首次落盘在极端断电下可能遗留孤儿 tmp 文件（随机名，无害）；追加路径仍是 `open(a)+write+fsync` 的 durable 语义，崩溃截断修复逻辑逐字保留。
- **纯公开 zstd API**：未复制 stock 的 Node 私有句柄解码器（性能优化），用 `zstdDecompressSync` 逐帧解码，正确性等价。
