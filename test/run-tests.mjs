// dsh-external-session 自测（Node 直跑，无需真实宿主）。
// 覆盖：纯函数（路径编码/帧扫描/header 往返）、路由、写入→列表→读取往返、
// 与 stock jsonl 后端互读、内部不受影响、move 迁移、重启恢复（重新构造后端再 list）。
//
// 运行：在本插件目录执行 `node test/run-tests.mjs`（依赖经 node_modules junction 解析）。
import { Context, Service } from "@deepseek-ai/cordis";
import { JsonlSessionPersistence } from "@deepseek-ai/dsh-session-persistence-jsonl";
import { mkdtemp, mkdir, open as fsOpen, rm, stat, cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RoutedJsonlPersistence,
  encodeSegment,
  fromHeaderLine,
  logPath,
  projectKey,
  scanZstdFrames,
  toHeaderLine,
} from "../lib/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
let passed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log("  \u2713 " + label); }
  else { failures += 1; console.log("  \u2717 " + label); }
}
async function throwsAsync(fn, label) {
  try { await fn(); ok(false, label + " (expected throw)"); }
  catch { ok(true, label + " (threw as expected)"); }
}

/** 满足 coordinator 只读需求的极简 sessions 服务。 */
class FakeSessions extends Service {
  constructor(ctx) { super(ctx, "sessions"); this._map = new Map(); }
  list() { return [...this._map.values()]; }
  get(id) { return this._map.get(id); }
  prepare() { throw new Error("prepare() not implemented in test"); }
  create() { throw new Error("create() not implemented in test"); }
}

function meta(id, cwd) {
  return { id, version: 0, cwd, createdAt: 1700000000000, delegationDepth: 0 };
}

function makeEvents(n) {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      seq: i,
      type: i % 2 === 0 ? "user/message" : "assistant/message",
      data: { id: "m" + i, role: "user", content: [{ type: "text", text: "msg " + i }], source: { kind: "human" } },
    });
  }
  return events;
}

async function main() {
  const tmp = await mkdtemp(join(__dirname, ".tmp-"));
  const internalRoot = join(tmp, "internal-sessions");
  const externalRoot = join(tmp, "proj", ".dsh-sessions");
  const cwdPrefix = join(tmp, "proj");
  const externalCwd = join(cwdPrefix, "src");
  const otherCwd = join(tmp, "elsewhere");

  const config = {
    enabled: true,
    internalRoot,
    external: [{ id: "test-ext", cwdPrefix, root: externalRoot }],
    packChunks: false,
    registerCommand: false,
    registerTools: false,
    registerWeb: false,
    listCacheTtlMs: 0,
  };

  console.log("\n== 1. 纯函数：路径编码 / header 往返 / 帧扫描 ==");

  ok(projectKey("H:\\RSProjects\\deepseek-harness-desktop") === "--H-RSProjects-deepseek-harness-desktop--",
    "projectKey 生成 --H-RSProjects-deepseek-harness-desktop--");
  ok(encodeSegment("..") === "~002E~002E", "encodeSegment 拒绝 .. 穿越");
  ok(encodeSegment("a/b") === "a~002Fb", "encodeSegment 转义 /");

  const h = meta("s1", externalCwd);
  const hLine = toHeaderLine(h);
  const hBack = fromHeaderLine(JSON.parse(JSON.stringify(hLine)));
  ok(hBack.id === "s1" && hBack.cwd === externalCwd && hBack.delegationDepth === 0, "header 序列化/反序列化往返");

  const lp = logPath(externalRoot, externalCwd, "s1", "zstd");
  ok(lp.includes("--") && lp.endsWith("session.jsonl.zstd"), "logPath 布局正确: " + lp);

  // 帧扫描：一个完整 zstd 帧应被识别，无 tornStart
  const { zstdCompressSync } = await import("node:zlib");
  const frame = zstdCompressSync(Buffer.from("hello\n"));
  const scanned = scanZstdFrames(frame);
  ok(scanned.frames.length === 1 && scanned.tornStart === undefined, "scanZstdFrames 识别完整帧");
  const torn = scanZstdFrames(frame.subarray(0, frame.length - 2));
  ok(torn.tornStart !== undefined, "scanZstdFrames 识别截断尾帧");

  console.log("\n== 2. 路由：外部 cwd 落外部，内部不受影响 ==");

  const ctx1 = new Context();
  new FakeSessions(ctx1);
  const backend = new RoutedJsonlPersistence(ctx1, config);
  // Keep this test independent from the user's persisted dynamic import entries.
  backend._dynamicFile = join(tmp, "dynamic-entries.json");
  backend._dynamicEntries.clear();
  ok(backend.addExternalEntry({ cwdPrefix, root: externalRoot }).id === "test-ext", "相同项目导入复用静态条目");

  const extId = "session-ext-001";
  await backend.create(meta(extId, externalCwd));
  await backend.append(extId, makeEvents(4));
  ok(await backend.exists(backend.logPathFor(externalRoot, externalCwd, extId)), "外部会话写入外部根");
  ok(!(await backend.exists(logPath(internalRoot, externalCwd, extId, "zstd"))), "外部会话不在内部根");

  const intId = "session-int-001";
  await backend.create(meta(intId, otherCwd));
  await backend.append(intId, makeEvents(2));
  ok(await backend.exists(logPath(internalRoot, otherCwd, intId, "zstd")), "内部会话写入内部根");
  ok(!(await backend.exists(logPath(externalRoot, otherCwd, intId, "zstd"))), "内部会话不在外部根");

  console.log("\n== 3. list / loadStored 往返 ==");

  const listed = await backend.list();
  ok(listed.some((x) => x.id === extId) && listed.some((x) => x.id === intId), "list 同时包含外部与内部会话");

  const stored = await backend.loadStored(extId);
  ok(stored.meta.id === extId && stored.events.length === 4 && stored.events[0].seq === 0, "loadStored 读取外部会话完整事件");
  ok(stored.events.map((e) => e.seq).join(",") === "0,1,2,3", "事件 seq 连续");

  console.log("\n== 4. 跨 clone 路径恢复：portable layout ==");

  const cloneA = join(tmp, "clone-a", "repo");
  const cloneB = join(tmp, "clone-b", "repo");
  const cloneRootA = join(cloneA, ".dsh-sessions");
  const cloneRootB = join(cloneB, ".dsh-sessions");
  const cloneConfig = {
    ...config,
    external: [{ id: "clone-a", cwdPrefix: cloneA, root: cloneRootA }],
  };
  const cloneCtxA = new Context();
  new FakeSessions(cloneCtxA);
  const cloneBackendA = new RoutedJsonlPersistence(cloneCtxA, cloneConfig);
  cloneBackendA._dynamicFile = join(tmp, "clone-a-dynamic.json");
  cloneBackendA._dynamicEntries.clear();
  const cloneSessionId = "session-clone-portable";
  await cloneBackendA.create(meta(cloneSessionId, join(cloneA, "src")));
  await cloneBackendA.append(cloneSessionId, makeEvents(3));
  ok((await stat(join(cloneRootA, "--rel-src--", encodeSegment(cloneSessionId), "session.jsonl.zstd"))).isFile(), "clone A 使用相对项目目录写入");
  await cp(cloneRootA, cloneRootB, { recursive: true });

  const cloneCtxB = new Context();
  new FakeSessions(cloneCtxB);
  const cloneBackendB = new RoutedJsonlPersistence(cloneCtxB, {
    ...config,
    external: [{ id: "clone-b", cwdPrefix: cloneB, root: cloneRootB }],
  });
  cloneBackendB._dynamicFile = join(tmp, "clone-b-dynamic.json");
  cloneBackendB._dynamicEntries.clear();
  const cloneListed = await cloneBackendB.list();
  const cloneStored = await cloneBackendB.loadStored(cloneSessionId);
  ok(cloneListed.some((x) => x.id === cloneSessionId && x.cwd === join(cloneB, "src")), "clone B 列表映射到当前绝对路径");
  ok(cloneStored.meta.cwd === join(cloneB, "src") && cloneStored.events.length === 3, "clone B 可加载完整对话");

  console.log("\n== 5. 原生格式互读：旧布局仍可由 stock jsonl 读取 ==");

  const legacyRoot = join(tmp, "legacy-root");
  const legacyCwd = join(tmp, "legacy-project", "src");
  const legacyId = "session-legacy-stock";
  const legacyCtx = new Context();
  new FakeSessions(legacyCtx);
  const legacyBackend = new RoutedJsonlPersistence(legacyCtx, {
    ...config,
    external: [],
    internalRoot: legacyRoot,
  });
  await legacyBackend.create(meta(legacyId, legacyCwd));
  await legacyBackend.append(legacyId, makeEvents(2));
  const stockCtx = new Context();
  new FakeSessions(stockCtx);
  const stock = new JsonlSessionPersistence(stockCtx, { root: legacyRoot });
  const stockList = await stock.list();
  ok(stockList.some((x) => x.id === legacyId), "stock 后端仍可读取旧布局");
  const stockStored = await stock.loadStored(legacyId);
  ok(stockStored && stockStored.events.length === 2, "旧布局日志格式保持互读");

  console.log("\n== 6. move 迁移：外部 → 内部 → 外部 ==");
  await backend.move(extId, "internal");
  ok(await backend.exists(logPath(internalRoot, externalCwd, extId, "zstd")), "move 后位于内部根");
  ok(!(await backend.exists(backend.logPathFor(externalRoot, externalCwd, extId))), "move 后外部根已清理");
  const movedList = await backend.list();
  ok(movedList.some((x) => x.id === extId), "move 后 list 仍可见");
  const movedStored = await backend.loadStored(extId);
  ok(movedStored.events.length === 4, "move 后事件完整");

  // 非自然 move 后继续追加：位置缓存保证写入跟随会话实际位置，不产生分叉文件
  await backend.append(extId, [{ seq: 4, type: "user/message", data: { id: "m4", role: "user", content: [{ type: "text", text: "after-move" }], source: { kind: "human" } } }]);
  ok(await backend.exists(logPath(internalRoot, externalCwd, extId, "zstd")), "非自然 move 后追加仍落内部根");
  ok(!(await backend.exists(backend.logPathFor(externalRoot, externalCwd, extId))), "外部根未产生分叉文件");
  const appendedStored = await backend.loadStored(extId);
  ok(appendedStored.events.length === 5, "追加后事件总数 5");

  await backend.move(extId, "test-ext");
  ok(await backend.exists(backend.logPathFor(externalRoot, externalCwd, extId)), "move 回外部根");
  ok(!(await backend.exists(logPath(internalRoot, externalCwd, extId, "zstd"))), "内部根已清理");

  // 同一 cwd 可以同时存在两个会话；徽标必须按实际日志根逐会话判断。
  const sameCwdInternalId = "session-same-cwd-internal";
  await backend.create(meta(sameCwdInternalId, externalCwd));
  await backend.append(sameCwdInternalId, makeEvents(1));
  await backend.move(sameCwdInternalId, "internal");
  ok(await backend.externalEntryForSession(extId) !== null, "同 cwd 的外部会话按实际根命中外部条目");
  ok(await backend.externalEntryForSession(sameCwdInternalId) === null, "同 cwd 的内部会话不被误标为外部");
  ok(!(await backend.exists(logPath(internalRoot, externalCwd, extId, "zstd"))), "内部根已清理");

  console.log("\n== 7. 重启恢复：全新 backend 实例 list 到持久化会话 ==");

  const ctx3 = new Context();
  new FakeSessions(ctx3);
  const backend2 = new RoutedJsonlPersistence(ctx3, config);
  const relisted = await backend2.list();
  ok(relisted.some((x) => x.id === extId) && relisted.some((x) => x.id === intId), "重启后两个会话均可见（外部即导入）");

  console.log("\n== 8. 容错：未知 rootId / 迁移 live 会话被拒 ==");

  await throwsAsync(() => backend.move(extId, "no-such-root"), "move 到未知 rootId 抛错");
  await throwsAsync(() => backend.move("session-does-not-exist", "internal"), "move 不存在的会话抛错");

  // live 会话被拒：把 extId 注册进 fake sessions
  const fakeSession = { id: extId };
  ctx1.sessions._map.set(extId, fakeSession);
  await throwsAsync(() => backend.move(extId, "internal"), "move live 会话被拒");

  console.log("\n== 8b. 崩溃截断尾帧容错（§9.8） ==");
  const tornId = "session-torn-001";
  await backend.create(meta(tornId, externalCwd));
  await backend.append(tornId, makeEvents(3));
  const tornPath = backend.logPathFor(externalRoot, externalCwd, tornId);
  const tornFrame = zstdCompressSync(Buffer.from(JSON.stringify({ seq: 3, type: "user/message", data: { id: "m3", role: "user", content: [{ type: "text", text: "torn" }], source: { kind: "human" } } }) + "\n"));
  const tornHandle = await fsOpen(tornPath, "a");
  await tornHandle.writeFile(tornFrame.subarray(0, tornFrame.length - 3));
  await tornHandle.close();
  const tornStored = await backend.loadStored(tornId);
  ok(tornStored.events.length >= 3 && tornStored.events[0].seq === 0, "截断尾帧被容忍，已确认事件不丢（events=" + tornStored.events.length + "）");
  ok(tornStored.tornMarker !== undefined, "返回 tornMarker 供恢复");

  console.log("\n== 9. status / listExternal（只读） ==");
  const st = await backend.status();
  ok(st.rows.length === 2 && st.rows[0].id === "internal" && st.rows[1].id === "test-ext", "status 列出 internal + external 两行");
  const ext = await backend.listExternal("test-ext");
  ok(ext.some((x) => x.id === extId), "listExternal 列出外部会话");

  console.log("\n== 10. 动态外部条目（导入/移除） ==");
  backend._dynamicFile = join(tmp, "dynamic-entries.json");
  backend._dynamicEntries.clear();
  const dynCwd = join(tmp, "another-proj");
  const dynRoot = join(dynCwd, ".dsh-sessions");
  ok(backend.externalEntryFor(dynCwd) === null, "导入前 dynCwd 非外部");
  const dynEntry = backend.addExternalEntry({ cwdPrefix: dynCwd, root: dynRoot });
  ok(dynEntry.id && backend.rootFor(dynCwd) === dynRoot, "addExternalEntry 后路由到动态 root");
  ok(backend.addExternalEntry({ cwdPrefix: dynCwd, root: dynRoot }).id === dynEntry.id, "相同项目导入复用既有动态条目");
  ok(backend.externalEntryFor(dynCwd) !== null, "externalEntryFor 命中动态条目");
  const dynId = "session-dyn-001";
  await backend.create(meta(dynId, dynCwd));
  await backend.append(dynId, makeEvents(2));
  ok(await backend.exists(backend.logPathFor(dynRoot, dynCwd, dynId)), "动态外部会话落动态 root");
  const dynamicSessions = await backend.listExternal(dynEntry.id);
  ok(dynamicSessions.some((x) => x.id === dynId), "listExternal 列出动态条目会话");
  backend.removeExternalEntry(dynEntry.id);
  ok(backend.rootFor(dynCwd) === internalRoot, "removeExternalEntry 后回退 internal");
  await throwsAsync(() => backend.removeExternalEntry("test-ext"), "remove 静态条目抛错");

  await rm(tmp, { recursive: true, force: true });
  console.log(`\n结果: ${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error("测试异常:", error);
  process.exit(2);
});
