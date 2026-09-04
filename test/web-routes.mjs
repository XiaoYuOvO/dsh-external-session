// 验证 Host HTTP 路由：fake webServer 捕获路由并调用，确认 config/import/external 正确响应。
import { Context, Service } from "@deepseek-ai/cordis";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { RoutedJsonlPersistence } from "../lib/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

class FakeWebServer extends Service {
  constructor(ctx) { super(ctx, "webServer"); this.routes = new Map(); }
  register(route) { this.routes.set(route.path, route); return () => this.routes.delete(route.path); }
}

function makeReq(method, url, body) {
  const chunks = body !== undefined ? [body] : [];
  return {
    method,
    url,
    setEncoding() {},
    on(ev, cb) {
      if (ev === "data") { for (const c of chunks) cb(c); }
      else if (ev === "end") { queueMicrotask(() => cb()); }
    },
  };
}
function makeRes() {
  const res = { statusCode: 200, headers: {}, body: "" };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (d) => { res.body = typeof d === "string" ? d : JSON.stringify(d); };
  return res;
}

let failures = 0;
function ok(cond, label) { console.log((cond ? "  ✓ " : "  ✗ ") + label); if (!cond) failures += 1; }

const tmp = await mkdtemp(join(__dirname, ".tmp-web-"));
const internalRoot = join(tmp, "internal");
const proj = join(tmp, "proj");
const externalRoot = join(proj, ".dsh-sessions");

const ctx = new Context();
new SessionStore(ctx);
const web = new FakeWebServer(ctx);

const backend = new RoutedJsonlPersistence(ctx, {
  enabled: true,
  internalRoot,
  external: [{ id: "test-ext", cwdPrefix: proj, root: externalRoot }],
  registerCommand: false,
  registerTools: false,
  registerWeb: true,
});

// ctx.inject 的激活是异步的：等注入 fiber 注册路由
await new Promise((r) => setTimeout(r, 50));
// 覆盖动态文件到临时路径，避免测试写入真实 $DSH_HOME（沙箱拦截）
backend._dynamicFile = join(tmp, "dynamic-entries.json");
backend._dynamicEntries.clear();
console.log("registered routes:", [...web.routes.keys()].sort().join(", "));
ok([...web.routes.keys()].sort().join(",") === "/external-session/config,/external-session/external,/external-session/import,/external-session/remove,/external-session/sessions", "5 条路由全部注册");

// config
const c = makeRes();
await web.routes.get("/external-session/config").handler(makeReq("GET", "/external-session/config"), c);
const cfg = JSON.parse(c.body);
ok(cfg.entries.length === 1 && cfg.entries[0].id === "test-ext", "config 返回静态条目");

// external（命中）
const e1 = makeRes();
await web.routes.get("/external-session/external").handler(makeReq("GET", "/external-session/external?cwd=" + encodeURIComponent(join(proj, "src"))), e1);
ok(JSON.parse(e1.body).external === true, "external 命中返回 true");

// external（未命中）
const e2 = makeRes();
await web.routes.get("/external-session/external").handler(makeReq("GET", "/external-session/external?cwd=" + encodeURIComponent(join(tmp, "other"))), e2);
ok(JSON.parse(e2.body).external === false, "external 未命中返回 false");

// external（同 cwd 的存储位置不同，必须按 sessionId 而不是 cwd 判定）
backend._locationCache.set("session-external", join(externalRoot, "project", "session-external", "session.jsonl.zstd"));
backend._locationCache.set("session-internal", join(internalRoot, "project", "session-internal", "session.jsonl.zstd"));
const oldFindLog = backend.findLog.bind(backend);
backend.findLog = async (id) => backend._locationCache.get(id) ?? oldFindLog(id);
const e3 = makeRes();
await web.routes.get("/external-session/external").handler(makeReq("GET", "/external-session/external?sessionId=session-external"), e3);
ok(JSON.parse(e3.body).external === true, "sessionId 位于 external root 返回 true");
const e4 = makeRes();
await web.routes.get("/external-session/external").handler(makeReq("GET", "/external-session/external?sessionId=session-internal"), e4);
ok(JSON.parse(e4.body).external === false, "sessionId 位于 internal root 返回 false（不按 cwd 误判）");
// import
const imp = makeRes();
await web.routes.get("/external-session/import").handler(makeReq("POST", "/external-session/import", JSON.stringify({ path: join(tmp, "other-proj") })), imp);
const impData = JSON.parse(imp.body);
ok(impData.ok === true && impData.entry.id && impData.entry.root === join(tmp, "other-proj", ".dsh-sessions"), "import 添加动态条目（root 默认 <path>/.dsh-sessions）");

// import 后路由生效
ok(backend.rootFor(join(tmp, "other-proj", "x")) === join(tmp, "other-proj", ".dsh-sessions"), "import 后 rootFor 命中动态条目");

// remove 动态条目
const rmRes = makeRes();
await web.routes.get("/external-session/remove").handler(makeReq("POST", "/external-session/remove", JSON.stringify({ id: impData.entry.id })), rmRes);
ok(JSON.parse(rmRes.body).ok === true, "remove 移除动态条目");

// remove 静态条目应 400
const rmStatic = makeRes();
await web.routes.get("/external-session/remove").handler(makeReq("POST", "/external-session/remove", JSON.stringify({ id: "test-ext" })), rmStatic);
ok(rmStatic.statusCode === 400, "remove 静态条目返回 400");

await rm(tmp, { recursive: true, force: true });
console.log(`\n结果: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
