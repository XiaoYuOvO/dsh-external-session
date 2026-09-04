// fork 继承外部存储属性的实测：真实 SessionStore.fork() + 真实路由后端
import { Context } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { RoutedJsonlPersistence } from "../lib/index.js";

const externalCwd = "H:\\RSProjects\\deepseek-harness-desktop\\src";
const externalRoot = "H:\\RSProjects\\deepseek-harness-desktop\\.dsh-sessions";
const internalCwd = "G:\\Deepseek Harness Desktop\\data\\dsh\\plugins";

const ctx = new Context();
const store = new SessionStore(ctx); // 提供 sessions 服务

const backend = new RoutedJsonlPersistence(ctx, {
  enabled: true,
  internalRoot: "",
  external: [{ id: "rsprojects-dsh", cwdPrefix: "H:\\RSProjects\\deepseek-harness-desktop", root: externalRoot }],
  registerCommand: false,
  registerTools: false,
});

// 1. 外部父会话
const parent = store.create("parent-ext-001", { meta: { cwd: externalCwd } });
console.log("[parent] id=%s cwd=%s", parent.header.id, parent.header.cwd);
console.log("[parent] rootFor =", backend.rootFor(parent.header.cwd));

// 2. fork 子会话
const child = store.fork(parent);
console.log("[child ] id=%s cwd=%s", child.header.id, child.header.cwd);
console.log("[child ] parentSession=%s", child.header.parentSession);
console.log("[child ] rootFor =", backend.rootFor(child.header.cwd));

// 3. 断言
const cwdInherited = child.header.cwd === parent.header.cwd;
const sameRoot = backend.rootFor(child.header.cwd) === backend.rootFor(parent.header.cwd);
const isExternal = backend.rootFor(child.header.cwd) === externalRoot;

console.log("\n--- 结论 ---");
console.log("子会话继承父 cwd:", cwdInherited);
console.log("子会话与父会话同 root:", sameRoot);
console.log("子会话落外部根:", isExternal);

// 对照：内部父会话 fork 后仍落内部
const intParent = store.create("parent-int-001", { meta: { cwd: internalCwd } });
const intChild = store.fork(intParent);
console.log("内部父/子同 root:", backend.rootFor(intChild.header.cwd) === backend.rootFor(intParent.header.cwd), "->", backend.rootFor(intChild.header.cwd));

process.exit(cwdInherited && sameRoot && isExternal ? 0 : 1);
