// dsh-external-session — routed JSONL session-persistence backend.
//
// This package REPLACES `@deepseek-ai/dsh-session-persistence-jsonl` with a
// routing backend that keeps the exact same on-disk layout, header line, and
// multi-frame zstd append protocol (so files are interchangeable with the stock
// reader), and adds exactly ONE decision point: choose the storage root by the
// session's cwd.
//
//   rootFor(cwd):
//     cwd under a configured external cwdPrefix  -> that entry's root
//     otherwise                                  -> internalRoot ($DSH_HOME/sessions)
//
// The implementation is a faithful copy of the stock JSONL backend's format,
// scanner, and zstd logic (the package does not export those internals), with
// `this.root` replaced by per-cwd routing and multi-root listing. See README.zh.md.

import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, truncate } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { scheduler } from "node:timers/promises";
import { promisify } from "node:util";
import { constants, zstdCompress, zstdDecompress, zstdDecompressSync } from "node:zlib";
import { SESSION_FORMAT_VERSION, decodeStorageRecord, packChunkRuns } from "@deepseek-ai/dsh-session";
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE,
  DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
  MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator,
  SessionFormatUnsupportedError,
  SessionPersistence,
  SessionPersistenceRevision,
  sessionFormatVersionRefusal,
} from "@deepseek-ai/dsh-session-persistence";
import { defineTool } from "@deepseek-ai/dsh-tools";

// ============================ 配置 ============================

const DEFAULT_PACK_CHUNKS = true;
const DEFAULT_COMPRESSION = "zstd";
const LIST_CACHE_TTL_MS = 1000;

const Config = z.object({
  enabled: z.boolean().default(true), // false = 纯内部根（不路由，仍提供持久化）
  internalRoot: z.string().default(""), // 空 = $DSH_HOME/sessions
  external: z.array(z.object({
    id: z.string().required(),
    cwdPrefix: z.string().required(),
    root: z.string().required(),
  })).default([]),
  packChunks: z.boolean().default(DEFAULT_PACK_CHUNKS),
  compression: z.union([z.const("zstd"), z.const("none")]).default(DEFAULT_COMPRESSION),
  preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
  writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS).default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  registerCommand: z.boolean().default(true),
  registerTools: z.boolean().default(true),
  registerWeb: z.boolean().default(true),
  listCacheTtlMs: z.number().step(1).min(0).default(LIST_CACHE_TTL_MS),
});

// ============================ 审计 ============================

function isoTime() {
  try { return new Date().toISOString(); } catch { /* ignore */ }
}

/** 一行结构化审计日志：只含标量，随 fiber 输出到 stderr，不落盘。 */
function audit(fields) {
  const entry = { time: isoTime(), ...fields };
  // 只保留标量/有界字段，绝不序列化 live 对象
  const clean = {};
  for (const [k, v] of Object.entries(entry)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") clean[k] = v;
  }
  console.error("[dsh-external-session]", JSON.stringify(clean));
}

// ============================ 路径工具 ============================

/** Windows 大小写不敏感比较时的归一化。 */
function normalizePath(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** child 是否等于 parent 或位于其下（解析为绝对路径、大小写归一，拒绝裸字符串前缀误判）。 */
function isInside(child, parent) {
  const c = normalizePath(resolve(String(child)));
  const p = normalizePath(resolve(String(parent)));
  if (c === p) return true;
  if (!c.startsWith(p)) return false;
  const next = c[p.length];
  return next === "\\" || next === "/";
}

function isENOENT(error) {
  return error?.code === "ENOENT";
}

function defaultInternalRoot() {
  const home = process.env.DSH_HOME || "";
  if (home) return join(home, "sessions");
  return join(homedir(), ".dsh", "sessions");
}

/**
 * 收容校验：路径必须绝对；已存在部分不得经符号链接解析到词法路径之外（PATH_UNSAFE 失败关闭）。
 * 同步实现，供构造函数使用；对尚不存在的路径回退到最近已存在祖先做 realpath 比对。
 */
function assertPathSafe(p, what) {
  const resolved = resolve(p);
  if (!isAbsolute(resolved)) {
    throw new Error(`[dsh-external-session] PATH_UNSAFE: ${what} must be an absolute path (got ${JSON.stringify(p)})`);
  }
  let probe = resolved;
  for (;;) {
    try {
      const real = normalizePath(realpathSync(probe));
      if (real !== normalizePath(probe)) {
        throw new Error(`[dsh-external-session] PATH_UNSAFE: ${what} resolves through a symlink (${probe} -> ${real})`);
      }
      return; // 找到已存在的非符号链接祖先，且其 realpath 与词法路径一致
    } catch (error) {
      if (error.code === "ENOENT") {
        const parent = dirname(probe);
        if (parent === probe) return; // 到达根
        probe = parent;
        continue;
      }
      // 权限等其它错误：不在此处静默放行，但也不误判为符号链接
      if (error.code === "EACCES" || error.code === "EPERM") return;
      throw error;
    }
  }
}

// ============================ 磁盘格式（与 jsonl 后端逐字一致） ============================

function logSuffix(compression) {
  return compression === "zstd" ? ".jsonl.zstd" : ".jsonl";
}

function toHeaderLine(header) {
  return {
    type: "session",
    version: header.version,
    id: header.id,
    createdAt: header.createdAt,
    ...header.cwd !== void 0 ? { cwd: header.cwd } : {},
    ...header.parentSession !== void 0 ? { parentSession: header.parentSession } : {},
    ...header.seedLength !== void 0 ? { seedLength: header.seedLength } : {},
    ...header.origin !== void 0 ? { origin: header.origin } : {},
    delegationDepth: header.delegationDepth ?? 0,
    ...header.agentPreset !== void 0 ? { agentPreset: header.agentPreset } : {},
  };
}

function fromHeaderLine(line) {
  if (Object.hasOwn(line, "sandboxMode") || Object.hasOwn(line, "approvalPolicy")) {
    throw new Error("session header uses retired policy baseline fields");
  }
  return {
    version: line.version,
    id: line.id,
    createdAt: line.createdAt,
    ...line.cwd !== void 0 ? { cwd: line.cwd } : {},
    ...line.parentSession !== void 0 ? { parentSession: line.parentSession } : {},
    ...line.seedLength !== void 0 ? { seedLength: line.seedLength } : {},
    ...line.origin !== void 0 ? { origin: line.origin } : {},
    delegationDepth: line.delegationDepth,
    ...line.agentPreset !== void 0 ? { agentPreset: line.agentPreset } : {},
  };
}

function isHeaderLine(value) {
  return typeof value === "object" && value !== null
    && value.type === "session"
    && typeof value.version === "number"
    && typeof value.id === "string"
    && typeof value.createdAt === "number" && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0 && !Object.is(value.createdAt, -0)
    && typeof value.delegationDepth === "number" && Number.isSafeInteger(value.delegationDepth) && value.delegationDepth >= 0 && !Object.is(value.delegationDepth, -0)
    && (value.origin === void 0 || value.origin === "subagent")
    && (value.agentPreset === void 0 || typeof value.agentPreset === "string");
}

function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

function projectDir(root, cwd) {
  if (cwd === void 0) return join(root, "_no-cwd");
  return join(root, projectKey(cwd));
}

// External project logs use a reversible, clone-path-independent directory key.
// The legacy absolute-path key remains readable for repositories written by older versions.
function portableProjectKey(relativeCwd) {
  const normalized = String(relativeCwd ?? "").replaceAll("\\", "/");
  return normalized === "" || normalized === "."
    ? "--rel-root--"
    : `--rel-${encodeSegment(normalized)}--`;
}

function decodePortableProjectKey(name) {
  if (name === "--rel-root--") return "";
  if (!name.startsWith("--rel-") || !name.endsWith("--")) return void 0;
  const encoded = name.slice(6, -2);
  if (encoded.length === 0) return void 0;
  let out = "";
  for (let i = 0; i < encoded.length;) {
    if (encoded[i] !== "~") {
      out += encoded[i++];
      continue;
    }
    if (i + 5 >= encoded.length || !/^[0-9A-Fa-f]{4}$/.test(encoded.slice(i + 1, i + 5))) return void 0;
    out += String.fromCharCode(parseInt(encoded.slice(i + 1, i + 5), 16));
    i += 5;
  }
  return out;
}


function sessionDir(root, cwd, id) {
  return join(projectDir(root, cwd), encodeSegment(id));
}

function logPath(root, cwd, id, compression) {
  return join(sessionDir(root, cwd, id), `session${logSuffix(compression)}`);
}

function eventLines(events, packChunks) {
  return (packChunks ? packChunkRuns(events) : events).map((record) => JSON.stringify(record)).join("\n");
}

function refuseForeignFormatVersion(parsed) {
  if (typeof parsed !== "object" || parsed === null) return;
  const { version, id } = parsed;
  if (typeof version !== "number" || version === SESSION_FORMAT_VERSION) return;
  throw new SessionFormatUnsupportedError(sessionFormatVersionRefusal(typeof id === "string" ? id : String(id), version));
}

function parseHeaderRecord(record) {
  if (record.length === 0 || record.at(-1) !== 10 || record.indexOf(10) !== record.length - 1) {
    throw new Error("empty or header-less session log");
  }
  let parsed;
  try {
    parsed = JSON.parse(record.subarray(0, -1).toString("utf8"));
  } catch {
    throw new Error("corrupt session log: header line is not valid JSON");
  }
  refuseForeignFormatVersion(parsed);
  if (!isHeaderLine(parsed)) throw new Error("corrupt session log: first line is not a session header");
  return fromHeaderLine(parsed);
}

class SessionLogScanner {
  meta;
  events = [];
  fragments = [];
  fragmentBytes = 0;
  inputBytes;
  committedBytes;
  eventLine = 0;
  issue;
  finished = false;

  constructor(headerRecord) {
    this.meta = parseHeaderRecord(headerRecord);
    this.inputBytes = headerRecord.length;
    this.committedBytes = headerRecord.length;
  }

  write(chunk) {
    if (this.finished) throw new Error("cannot write to a finished session log scanner");
    const chunkStart = this.inputBytes;
    this.inputBytes += chunk.length;
    let lineStart = 0;
    for (let newline = chunk.indexOf(10); newline !== -1; newline = chunk.indexOf(10, lineStart)) {
      const fragment = chunk.subarray(lineStart, newline);
      let line = fragment;
      if (this.fragments.length > 0) {
        if (fragment.length > 0) this.fragments.push(fragment);
        line = Buffer.concat(this.fragments, this.fragmentBytes + fragment.length);
        this.fragments = [];
        this.fragmentBytes = 0;
      }
      this.consumeEventLine(line, chunkStart + newline + 1);
      lineStart = newline + 1;
    }
    if (lineStart < chunk.length) {
      const fragment = Buffer.from(chunk.subarray(lineStart));
      this.fragments.push(fragment);
      this.fragmentBytes += fragment.length;
    }
  }

  checkpoint() {
    return { inputBytes: this.inputBytes, committedBytes: this.committedBytes, eventCount: this.events.length };
  }

  finish() {
    this.finished = true;
    return { meta: this.meta, events: this.events, committedBytes: this.committedBytes };
  }

  consumeEventLine(line, endByte) {
    this.eventLine += 1;
    let decoded;
    try {
      decoded = decodeStorageRecord(JSON.parse(line.toString("utf8")));
    } catch {
      this.issue ??= new Error(`corrupt session log: unparsable committed event at line ${this.eventLine}`);
      return;
    }
    if (this.issue !== void 0) {
      if (decoded.some((event) => event.type === "turn/end")) throw this.issue;
      return;
    }
    const rowStart = this.events.length;
    for (const event of decoded) {
      if (event.seq !== this.events.length) {
        const expected = this.events.length;
        this.events.length = rowStart;
        this.issue = new Error(`corrupt session log: seq gap in committed region at line ${this.eventLine} (expected ${expected}, got ${event.seq})`);
        if (decoded.some((candidate) => candidate.type === "turn/end")) throw this.issue;
        return;
      }
      this.events.push(event);
    }
    this.committedBytes = endByte;
  }
}

function scanLog(buffer) {
  const headerEnd = buffer.indexOf(10);
  if (headerEnd === -1) throw new Error("empty or header-less session log");
  const scanner = new SessionLogScanner(buffer.subarray(0, headerEnd + 1));
  scanner.write(buffer.subarray(headerEnd + 1));
  return scanner.finish();
}

function parseHeaderMeta(firstLine) {
  let parsed;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    return;
  }
  if (!isHeaderLine(parsed)) return void 0;
  return fromHeaderLine(parsed);
}

// ============================ zstd（仅用公开 API；帧结构扫描逐字复制） ============================

const ZSTD_MAGIC = 4247762216;
const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const INCOMPLETE_FRAME_OPTIONS = { finishFlush: constants.ZSTD_e_flush };
const ZSTD_DECODE_YIELD_INTERVAL_MS = 500;
const DECODE_CHUNK_SIZE = 1024 * 1024;

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = blockHeader >>> 1 & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

async function compressZstdFrame(input) {
  return zstdCompressAsync(input, CHECKSUM_OPTIONS);
}

async function decompressZstdFrame(input) {
  return zstdDecompressAsync(input);
}

async function decompressZstdPrefix(input) {
  return zstdDecompressAsync(input, INCOMPLETE_FRAME_OPTIONS);
}

class PublicZstdFrameDecoder {
  started = false;
  closed = false;

  *decode(source, frames) {
    if (this.started) throw new Error("Zstandard frame decoder was already started");
    if (this.closed) throw new Error("cannot start a closed Zstandard frame decoder");
    this.started = true;
    try {
      for (const { start, end } of frames) {
        let decoded;
        try {
          decoded = zstdDecompressSync(source.subarray(start, end));
        } catch (error) {
          throw new Error(`corrupt Zstandard session log: frame at byte ${start} failed validation`, { cause: error });
        }
        yield decoded;
      }
    } finally {
      this.close();
    }
  }

  close() {
    this.closed = true;
  }
}

function createZstdFrameDecoder() {
  return new PublicZstdFrameDecoder();
}

function assertZstdHeaderFrame(plaintext) {
  if (plaintext.length === 0 || plaintext.indexOf(10) !== plaintext.length - 1) {
    throw new Error("corrupt Zstandard session log: first frame is not exactly one header line");
  }
}

function fileRevision(identity) {
  return SessionPersistenceRevision([identity.dev, identity.ino, identity.size, identity.mtimeNs, identity.ctimeNs].join(":"));
}

// ============================ 路由后端 ============================

class RoutedJsonlPersistence extends SessionPersistence {
  config;
  supportsRawArtifacts = true;
  static inject = ["sessions"];
  static Config = Config;
  name = "session-persistence-external";

  internalRoot;
  externalEntries = [];
  packChunks;
  compression;
  coordinator;
  rootEncodingCheck;
  _listCache = { headers: null, at: 0 };
  _listTtlMs;
  _locationCache = new Map();
  _commandFiber;
  _toolFiber;

  constructor(ctx, config) {
    super(ctx);
    this.config = config;
    this.packChunks = config.packChunks ?? DEFAULT_PACK_CHUNKS;
    this.compression = config.compression ?? DEFAULT_COMPRESSION;
    this._listTtlMs = config.listCacheTtlMs ?? LIST_CACHE_TTL_MS;
    this.internalRoot = resolve(config.internalRoot || defaultInternalRoot());
    this.externalEntries = (config.external || []).map((entry) => ({
      id: entry.id,
      cwdPrefix: resolve(entry.cwdPrefix),
      root: resolve(entry.root),
    }));
    this._dynamicEntries = new Map();
    this._dynamicFile = join(process.env.DSH_HOME || dirname(this.internalRoot), "dsh-external-session.json");
    this.loadDynamicEntries();
    this.validateConfig();
    this.assertUsableRoot();
    const preparedSessionCacheSize = config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE;
    const writeBatchMaxDelayMs = config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS;
    this.coordinator = new PersistenceCoordinator(this.ctx, this, {
      preparedSessionCacheSize,
      writeBatchMaxDelayMs,
    });
    this.setupExtensions();
  }

  // ---------- 路由 ----------

  /** 按 cwd 选 root。禁用或未命中 external 一律回 internalRoot。 */
  rootFor(cwd) {
    if (cwd === void 0 || cwd === null || cwd === "") return this.internalRoot;
    if (!this.config.enabled) return this.internalRoot;
    const p = String(cwd);
    for (const entry of this.allExternalEntries()) {
      if (isInside(p, entry.cwdPrefix)) return entry.root;
    }
    return this.internalRoot;
  }

  externalEntryForRoot(root) {
    return this.allExternalEntries().find((entry) => normalizePath(entry.root) === normalizePath(root)) ?? null;
  }

  relativeExternalCwd(entry, cwd) {
    const rel = relative(entry.cwdPrefix, String(cwd ?? entry.cwdPrefix)).replaceAll("\\", "/");
    if (rel === "" || rel === ".") return "";
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      throw new Error(`cwd ${JSON.stringify(cwd)} is outside external project ${JSON.stringify(entry.cwdPrefix)}`);
    }
    return rel;
  }

  projectDirFor(root, cwd) {
    const entry = this.externalEntryForRoot(root);
    if (entry !== null) return join(root, portableProjectKey(this.relativeExternalCwd(entry, cwd)));
    return projectDir(root, cwd);
  }

  sessionDirFor(root, cwd, id) {
    return join(this.projectDirFor(root, cwd), encodeSegment(id));
  }

  logPathFor(root, cwd, id, compression = this.compression) {
    return join(this.sessionDirFor(root, cwd, id), `session${logSuffix(compression)}`);
  }

  rootContainingPath(path) {
    return this.allExternalEntries().find((entry) => isInside(path, entry.root))?.root ?? this.internalRoot;
  }

  /** 将仓库内日志 header 的旧 cwd 映射到当前 clone 的项目路径。 */
  remapExternalMeta(meta, path) {
    const entry = this.externalEntryForRoot(this.rootContainingPath(path));
    if (entry === null || meta.cwd === void 0 || meta.cwd === "") return meta;
    const projectName = basename(dirname(dirname(path)));
    const rel = decodePortableProjectKey(projectName);
    if (rel !== void 0) return { ...meta, cwd: resolve(join(entry.cwdPrefix, rel)) };

    // Legacy absolute-path layout: preserve the suffix after a matching repository name.
    const old = resolve(String(meta.cwd));
    const oldParts = old.replaceAll("\\", "/").split("/").filter(Boolean);
    const repoName = basename(entry.cwdPrefix).toLowerCase();
    const marker = oldParts.findIndex((part) => part.toLowerCase() === repoName);
    if (marker >= 0) {
      const suffix = oldParts.slice(marker + 1).join("/");
      return { ...meta, cwd: suffix ? resolve(join(entry.cwdPrefix, suffix)) : entry.cwdPrefix };
    }
    return { ...meta, cwd: entry.cwdPrefix };
  }


  roots() {
    const seen = new Set();
    const out = [];
    const add = (p) => {
      const n = normalizePath(p);
      if (!seen.has(n)) { seen.add(n); out.push(p); }
    };
    add(this.internalRoot);
    for (const e of this.allExternalEntries()) add(e.root);
    return out;
  }

  externalEntryById(id) {
    const entry = this.allExternalEntries().find((e) => e.id === id);
    if (!entry) throw new Error(`unknown external root id ${JSON.stringify(id)}; known: ${this.allExternalEntries().map((e) => e.id).join(", ") || "(none)"}`);
    return entry;
  }

  /** 全部 external 条目（静态配置 + 运行时动态导入）。 */
  allExternalEntries() {
    return [...this.externalEntries, ...this._dynamicEntries.values()];
  }

  /** 判断 cwd 是否命中外部条目；命中返回该条目，否则 null。 */
  externalEntryFor(cwd) {
    if (cwd === void 0 || cwd === null || cwd === "") return null;
    if (!this.config.enabled) return null;
    const p = String(cwd);
    for (const entry of this.allExternalEntries()) {
      if (isInside(p, entry.cwdPrefix)) return entry;
    }
    return null;
  }
  /**
   * Resolve one persisted session's actual storage root.  cwd routing alone is
   * insufficient: `move()` deliberately permits an existing session to live in
   * a different root from the one its cwd would choose today.
   */
  async externalEntryForSession(id, signal) {
    if (!id || !this.config.enabled) return null;
    const path = await this.findLog(String(id), signal);
    if (path === void 0) return null;
    for (const entry of this.allExternalEntries()) {
      if (isInside(path, entry.root)) return entry;
    }
    return null;
  }

  loadDynamicEntries() {
    this._dynamicEntries.clear();
    try {
      const raw = readFileSync(this._dynamicFile, "utf8");
      const data = JSON.parse(raw);
      for (const entry of Array.isArray(data) ? data : []) {
        if (!entry || typeof entry.id !== "string" || typeof entry.cwdPrefix !== "string" || typeof entry.root !== "string") continue;
        this._dynamicEntries.set(entry.id, { id: entry.id, cwdPrefix: resolve(entry.cwdPrefix), root: resolve(entry.root), dynamic: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") audit({ event: "dynamic-load-error", error: error?.message });
    }
  }

  saveDynamicEntries() {
    try {
      mkdirSync(dirname(this._dynamicFile), { recursive: true });
      const data = [...this._dynamicEntries.values()].map((e) => ({ id: e.id, cwdPrefix: e.cwdPrefix, root: e.root }));
      writeFileSync(this._dynamicFile, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      audit({ event: "dynamic-save-error", error: error?.message });
      throw error;
    }
  }

  /** 运行时导入外部项目：校验并加入动态条目（持久化到 $DSH_HOME/dsh-external-session.json）。 */
  addExternalEntry(input) {
    const cwdPrefix = resolve(String(input.cwdPrefix ?? input.path ?? ""));
    const root = resolve(String(input.root ?? join(cwdPrefix, ".dsh-sessions")));
    const id = String(input.id ?? "").trim() || this.deriveEntryId(cwdPrefix);
    const existing = this.allExternalEntries().find((entry) =>
      normalizePath(entry.cwdPrefix) === normalizePath(cwdPrefix) && normalizePath(entry.root) === normalizePath(root));
    if (existing) return existing;
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`invalid external root id ${JSON.stringify(id)}`);
    assertPathSafe(cwdPrefix, `dynamic external[${id}].cwdPrefix`);
    assertPathSafe(root, `dynamic external[${id}].root`);
    if (this.allExternalEntries().some((e) => e.id === id)) throw new Error(`external root id ${JSON.stringify(id)} already exists`);
    const entry = { id, cwdPrefix, root, dynamic: true };
    this._dynamicEntries.set(id, entry);
    this.saveDynamicEntries();
    this._listCache.headers = null;
    this.rootEncodingCheck = undefined;
    audit({ event: "external-import", id, cwdPrefix, root });
    return entry;
  }

  /** 移除一个动态（运行时导入的）外部条目；静态条目不可移除。 */
  removeExternalEntry(id) {
    const entry = this._dynamicEntries.get(id);
    if (!entry) {
      const staticEntry = this.externalEntries.find((e) => e.id === id);
      if (staticEntry) throw new Error(`external root ${JSON.stringify(id)} is static config (profile patch); remove it from the profile cordis.patch.yml instead`);
      throw new Error(`unknown external root id ${JSON.stringify(id)}`);
    }
    this._dynamicEntries.delete(id);
    this.saveDynamicEntries();
    this._listCache.headers = null;
    this.rootEncodingCheck = undefined;
    audit({ event: "external-remove", id });
    return true;
  }

  /** 由 cwd 派生一个稳定展示名。 */
  deriveEntryId(cwdPrefix) {
    const base = basename(cwdPrefix) || "external";
    const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "external";
    let id = sanitized;
    let n = 2;
    while (this.allExternalEntries().some((e) => e.id === id)) id = `${sanitized}-${n++}`;
    return id;
  }

  validateConfig() {
    const ids = new Set();
    const rootsSeen = new Set();
    for (const entry of this.externalEntries) {
      if (ids.has(entry.id)) throw new Error(`duplicate external root id ${JSON.stringify(entry.id)}`);
      ids.add(entry.id);
      if (!entry.id || !/^[A-Za-z0-9._-]+$/.test(entry.id)) throw new Error(`external root id must match [A-Za-z0-9._-]: ${JSON.stringify(entry.id)}`);
      assertPathSafe(entry.cwdPrefix, `external[${entry.id}].cwdPrefix`);
      assertPathSafe(entry.root, `external[${entry.id}].root`);
      const rn = normalizePath(entry.root);
      if (rootsSeen.has(rn)) throw new Error(`external root path collision: multiple entries share root ${JSON.stringify(entry.root)}`);
      rootsSeen.add(rn);
    }
    assertPathSafe(this.internalRoot, "internalRoot");
    const internalN = normalizePath(this.internalRoot);
    if (rootsSeen.has(internalN)) throw new Error(`external root path collides with internalRoot: ${JSON.stringify(this.internalRoot)}`);
  }

  assertUsableRoot() {
    for (const root of this.roots()) {
      try {
        readdirSync(root);
      } catch (error) {
        if (isENOENT(error)) continue;
        throw error;
      }
    }
  }

  // ---------- 后端 seam（coordinator 回调） ----------
  locate(meta) {
    const root = this.rootFor(meta.cwd);
    return { kind: "jsonl", path: this.logPathFor(root, meta.cwd, meta.id) };
  }
  create(meta) {
    return this.coordinator.create(meta);
  }

  append(id, events) {
    return this.coordinator.append(id, events);
  }

  prepare(id, signal) {
    return this.coordinator.prepare(id, signal);
  }

  load(id) {
    return this.coordinator.load(id);
  }

  inspect(id, signal) {
    return this.coordinator.inspect(id, signal);
  }

  readFrom(id, fromSeq, signal) {
    return this.coordinator.readFrom(id, fromSeq, signal);
  }

  async loadStored(id, signal) {
    signal?.throwIfAborted();
    await this.ensureRootEncoding();
    signal?.throwIfAborted();
    const path = await this.findLog(id, signal);
    if (path === void 0) return void 0;
    return this.readPrefix(path, id, signal);
  }

  async readStoredRevision(id, signal) {
    signal?.throwIfAborted();
    await this.ensureRootEncoding();
    signal?.throwIfAborted();
    const path = await this.findLog(id, signal);
    if (path === void 0) return void 0;
    try {
      const identity = await stat(path, { bigint: true });
      signal?.throwIfAborted();
      return fileRevision(identity);
    } catch (error) {
      signal?.throwIfAborted();
      if (isENOENT(error)) return void 0;
      throw error;
    }
  }

  async readRaw(id, signal) {
    signal?.throwIfAborted();
    await this.ensureRootEncoding();
    signal?.throwIfAborted();
    const path = await this.findLog(id, signal);
    if (path === void 0) return void 0;
    const { buffer } = await this.readStableFile(path, signal);
    let content;
    if (this.compression === "zstd") {
      const { frames } = scanZstdFrames(buffer);
      if (frames.length === 0) throw new Error("empty or header-less Zstandard session log");
      const decoder = createZstdFrameDecoder();
      const plaintexts = [];
      try {
        for (const plaintext of decoder.decode(buffer, frames)) {
          signal?.throwIfAborted();
          plaintexts.push(Buffer.from(plaintext));
        }
      } finally {
        decoder.close();
      }
      content = Buffer.concat(plaintexts).toString("utf8");
    } else {
      content = buffer.toString("utf8");
    }
    const rawMeta = parseHeaderMeta(content.split("\n", 1)[0]);
    if (rawMeta === void 0 || rawMeta.id !== id) throw new Error(`corrupt session log: invalid header line in "${path}"`);
    const meta = this.remapExternalMeta(rawMeta, path);
    return { meta, filename: "session.jsonl", content };
  }

  async readStableFile(path, signal) {
    for (;;) {
      signal?.throwIfAborted();
      const before = fileRevision(await stat(path, { bigint: true }));
      const buffer = await readFile(path, { signal });
      signal?.throwIfAborted();
      const after = fileRevision(await stat(path, { bigint: true }));
      if (before === after) return { buffer, revision: after };
    }
  }

  async readPrefix(path, expectedId, signal) {
    const { buffer, revision } = await this.readStableFile(path, signal);
    let prefix;
    try {
      if (this.compression === "zstd") {
        prefix = await this.readZstdPrefix(buffer, signal);
      } else {
        signal?.throwIfAborted();
        const { meta, events, committedBytes } = scanLog(buffer);
        signal?.throwIfAborted();
        prefix = {
          meta,
          events,
          ...committedBytes < buffer.byteLength ? { tornMarker: { truncateTo: committedBytes, recoveredEvents: [] } } : {},
        };
      }
    } catch (error) {
      if (error instanceof SessionFormatUnsupportedError && error.location === void 0) {
        throw new SessionFormatUnsupportedError(`${error.message} (raw log: ${path})`, { kind: "jsonl", path });
      }
      throw error;
    }
    signal?.throwIfAborted();
    const rawMeta = prefix.meta;
    await this.assertStoredIdentity(path, rawMeta, expectedId, signal);
    const meta = this.remapExternalMeta(rawMeta, path);
    signal?.throwIfAborted();
    return { ...prefix, meta, revision };
  }

  async readZstdPrefix(buffer, signal) {
    signal?.throwIfAborted();
    const { frames, tornStart } = scanZstdFrames(buffer);
    signal?.throwIfAborted();
    if (frames.length === 0) throw new Error("empty or header-less Zstandard session log");
    const decoder = createZstdFrameDecoder();
    let yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS;
    try {
      const decodedFrames = decoder.decode(buffer, frames);
      signal?.throwIfAborted();
      const headerFrame = decodedFrames.next();
      signal?.throwIfAborted();
      if (headerFrame.done) throw new Error("empty or header-less Zstandard session log");
      assertZstdHeaderFrame(headerFrame.value);
      const scanner = new SessionLogScanner(headerFrame.value);
      let remainingFrames = frames.length - 1;
      for (const plaintext of decodedFrames) {
        signal?.throwIfAborted();
        scanner.write(plaintext);
        remainingFrames -= 1;
        if (remainingFrames > 0 && performance.now() >= yieldDeadline) {
          await scheduler.yield();
          signal?.throwIfAborted();
          yieldDeadline = performance.now() + ZSTD_DECODE_YIELD_INTERVAL_MS;
        }
      }
      signal?.throwIfAborted();
      const complete = scanner.checkpoint();
      if (complete.committedBytes !== complete.inputBytes) {
        throw new Error("corrupt Zstandard session log: complete frame contains a torn JSONL record");
      }
      if (tornStart === void 0) {
        const prefix = scanner.finish();
        return { meta: prefix.meta, events: prefix.events };
      }
      let recoveredPlaintext = Buffer.alloc(0);
      try {
        signal?.throwIfAborted();
        recoveredPlaintext = await decompressZstdPrefix(buffer.subarray(tornStart));
      } catch {
        if (signal?.aborted) signal.throwIfAborted();
      }
      signal?.throwIfAborted();
      scanner.write(recoveredPlaintext);
      const recoveredPrefix = scanner.finish();
      signal?.throwIfAborted();
      return {
        meta: recoveredPrefix.meta,
        events: recoveredPrefix.events,
        tornMarker: { truncateTo: tornStart, recoveredEvents: recoveredPrefix.events.slice(complete.eventCount) },
      };
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      throw error;
    } finally {
      decoder.close();
    }
  }

  async appendBatch(meta, events, isMaterialized) {
    await this.ensureRootEncoding();
    if (isMaterialized) await this.appendLines(meta, events);
    else await this.materialize(meta, events);
  }

  async commitRepair(meta, tornMarker, closers) {
    if (tornMarker !== void 0) await this.repair(meta, tornMarker.truncateTo);
    const repairedEvents = [...tornMarker?.recoveredEvents ?? [], ...closers];
    if (repairedEvents.length > 0) await this.appendLines(meta, repairedEvents);
  }

  // ---------- list ----------

  async list(signal) {
    const now = Date.now();
    if (this._listCache.headers !== null && now - this._listCache.at < this._listTtlMs) {
      return this._listCache.headers;
    }
    const headers = (await this.listArtifacts(signal)).map((artifact) => artifact.header);
    this._listCache = { headers, at: now };
    return headers;
  }

  async listSnapshots(signal) {
    const snapshots = [];
    for (const artifact of await this.listArtifacts(signal)) {
      signal?.throwIfAborted();
      try {
        const identity = await stat(artifact.path, { bigint: true });
        signal?.throwIfAborted();
        snapshots.push({ header: artifact.header, revision: fileRevision(identity) });
      } catch (error) {
        signal?.throwIfAborted();
        if (!isENOENT(error)) throw error;
      }
    }
    signal?.throwIfAborted();
    return snapshots;
  }

  async listArtifacts(signal) {
    signal?.throwIfAborted();
    await this.ensureRootEncoding();
    signal?.throwIfAborted();
    const artifacts = [];
    const ids = new Set();
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted();
      for (const dir of await this.listSessionDirs(project, signal)) {
        signal?.throwIfAborted();
        const opposite = join(dir, `session${logSuffix(this.oppositeCompression())}`);
        const oppositeExists = await this.exists(opposite);
        signal?.throwIfAborted();
        if (oppositeExists) throw this.encodingMismatch(opposite);
        const path = join(dir, `session${logSuffix(this.compression)}`);
        const pathExists = await this.exists(path);
        signal?.throwIfAborted();
        if (!pathExists) continue;
        const first = this.compression === "zstd"
          ? await this.readFirstZstdLine(path, signal)
          : await this.readFirstLine(path, signal);
        signal?.throwIfAborted();
        if (first === void 0) continue;
        const rawMeta = parseHeaderMeta(first);
        if (rawMeta === void 0) continue;
        await this.assertStoredIdentity(path, rawMeta, void 0, signal);
        const meta = this.remapExternalMeta(rawMeta, path);
        if (ids.has(meta.id)) throw new Error(`duplicate JSONL session id "${meta.id}" appears in multiple project directories`);
        ids.add(meta.id);
        artifacts.push({ header: meta, path });
      }
    }
    signal?.throwIfAborted();
    return artifacts;
  }

  // ---------- materialize / append / repair ----------

  async materialize(meta, events) {
    const root = this.rootFor(meta.cwd);
    const project = this.projectDirFor(root, meta.cwd);
    const dir = this.sessionDirFor(root, meta.cwd, meta.id);
    const finalPath = this.logPathFor(root, meta.cwd, meta.id);
    await this.rejectOppositeArtifact(meta.cwd, meta.id);
    const content = await this.encodeMaterialization(meta, events);
    await this.materializePlain(root, project, dir, finalPath, meta.id, content);
    this._listCache.headers = null;
    this._locationCache.set(meta.id, finalPath);
    audit({ event: "materialize", sessionId: meta.id, cwd: meta.cwd, root, external: root !== this.internalRoot });
  }
  async materializePlain(root, project, dir, finalPath, id, content) {
    await mkdir(root, { recursive: true });
    await mkdir(project, { recursive: true });
    await mkdir(dir, { recursive: true });
    await this.rejectExistingLog(finalPath, id);
    const tmp = await this.writeSyncedTempFile(finalPath, content);
    try {
      await rename(tmp, finalPath);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async rejectExistingLog(finalPath, id) {
    if (await this.exists(finalPath)) {
      throw new Error(`refusing to materialize "${id}": a log already exists on disk (load/resume it instead)`);
    }
  }

  async writeSyncedTempFile(finalPath, content) {
    const tmp = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return tmp;
  }

  async encodeMaterialization(meta, events) {
    const header = JSON.stringify(toHeaderLine(meta)) + "\n";
    const body = eventLines(events, this.packChunks) + "\n";
    if (this.compression === "none") return header + body;
    const headerFrame = await compressZstdFrame(header);
    const eventFrame = await compressZstdFrame(body);
    return Buffer.concat([headerFrame, eventFrame]);
  }

  async encodeEventBatch(events) {
    const body = eventLines(events, this.packChunks) + "\n";
    return this.compression === "zstd" ? compressZstdFrame(body) : body;
  }

  async appendLines(meta, events) {
    const content = await this.encodeEventBatch(events);
    const path = this._locationCache.get(meta.id) ?? this.logPathFor(this.rootFor(meta.cwd), meta.cwd, meta.id);
    const handle = await open(path, "a");
    let closed = false;
    const closeAppendHandle = async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    };
    try {
      const { size: before } = await handle.stat();
      try {
        await handle.writeFile(content);
        await handle.sync();
      } catch (error) {
        try {
          await closeAppendHandle();
          await this.rollbackAppend(path, before);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`);
        }
        throw error;
      }
    } finally {
      await closeAppendHandle();
    }
  }

  async rollbackAppend(path, size) {
    const handle = await open(path, "r+");
    try {
      await handle.truncate(size);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async repair(meta, offset) {
    const path = this._locationCache.get(meta.id) ?? this.logPathFor(this.rootFor(meta.cwd), meta.cwd, meta.id);
    await truncate(path, offset);
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  // ---------- 首行读取 / 定位 / 校验 ----------

  async readFirstLine(path, signal) {
    signal?.throwIfAborted();
    const handle = await open(path, "r");
    try {
      signal?.throwIfAborted();
      const chunks = [];
      const buf = Buffer.alloc(8192);
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buf, 0, buf.length, null);
        signal?.throwIfAborted();
        if (bytesRead === 0) return void 0;
        const slice = buf.subarray(0, bytesRead);
        const nl = slice.indexOf(10);
        if (nl !== -1) {
          chunks.push(slice.subarray(0, nl));
          signal?.throwIfAborted();
          return Buffer.concat(chunks).toString("utf8");
        }
        chunks.push(Buffer.from(slice));
      }
    } finally {
      await handle.close();
    }
  }

  async readFirstZstdLine(path, signal) {
    signal?.throwIfAborted();
    const handle = await open(path, "r");
    try {
      signal?.throwIfAborted();
      let content = Buffer.alloc(0);
      const chunk = Buffer.alloc(8192);
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        signal?.throwIfAborted();
        if (bytesRead === 0) return void 0;
        signal?.throwIfAborted();
        content = Buffer.concat([content, chunk.subarray(0, bytesRead)]);
        signal?.throwIfAborted();
        const first = scanZstdFrames(content, 1).frames[0];
        signal?.throwIfAborted();
        if (first === void 0) continue;
        let plaintext;
        try {
          signal?.throwIfAborted();
          plaintext = await decompressZstdFrame(content.subarray(first.start, first.end));
        } catch (error) {
          if (signal?.aborted) signal.throwIfAborted();
          throw new Error("corrupt Zstandard session log: header frame failed validation", { cause: error });
        }
        signal?.throwIfAborted();
        assertZstdHeaderFrame(plaintext);
        return plaintext.subarray(0, -1).toString("utf8");
      }
    } finally {
      await handle.close();
    }
  }

  async findLog(id, signal) {
    const matches = [];
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted();
      await this.rejectLegacyFlatArtifact(project, id, signal);
      signal?.throwIfAborted();
      const dir = join(project, encodeSegment(id));
      const path = join(dir, `session${logSuffix(this.compression)}`);
      const opposite = join(dir, `session${logSuffix(this.oppositeCompression())}`);
      const oppositeExists = await this.exists(opposite);
      signal?.throwIfAborted();
      if (oppositeExists) throw this.encodingMismatch(opposite);
      const pathExists = await this.exists(path);
      signal?.throwIfAborted();
      if (pathExists) matches.push(path);
    }
    if (matches.length > 1) throw new Error(`duplicate JSONL session id "${id}" appears in multiple project directories`);
    signal?.throwIfAborted();
    if (matches[0] !== void 0) this._locationCache.set(id, matches[0]);
    return matches[0];
  }

  async assertStoredIdentity(path, meta, expectedId, signal) {
    signal?.throwIfAborted();
    if (expectedId !== void 0 && meta.id !== expectedId) {
      throw new Error(`corrupt session log "${path}": requested id "${expectedId}" does not match header id "${meta.id}"`);
    }
    const projectDirName = basename(dirname(dirname(path)));
    const entry = this.externalEntryForRoot(this.rootContainingPath(path));
    const portableRel = decodePortableProjectKey(projectDirName);
    if (entry !== null && portableRel !== void 0) {
      if (portableRel === ".." || portableRel.startsWith("../") || isAbsolute(portableRel)) {
        throw new Error(`corrupt session log "${path}": invalid portable project directory "${projectDirName}"`);
      }
    } else {
      const expectedProject = meta.cwd === void 0 || meta.cwd === "" ? "_no-cwd" : projectKey(meta.cwd);
      if (projectDirName !== expectedProject) {
        throw new Error(`corrupt session log "${path}": header cwd "${meta.cwd}" identifies project directory "${expectedProject}"`);
      }
    }
    signal?.throwIfAborted();
  }

  async projectDirsIn(root, signal) {
    signal?.throwIfAborted();
    try {
      const entries = await readdir(root, { withFileTypes: true });
      signal?.throwIfAborted();
      return entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name));
    } catch (error) {
      if (isENOENT(error)) return [];
      throw error;
    }
  }

  async listProjectDirs(signal) {
    const out = [];
    for (const root of this.roots()) {
      for (const d of await this.projectDirsIn(root, signal)) out.push(d);
    }
    return out;
  }

  async listSessionDirs(project, signal) {
    signal?.throwIfAborted();
    const entries = await readdir(project, { withFileTypes: true });
    signal?.throwIfAborted();
    const legacy = entries.find((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zstd")));
    if (legacy !== void 0) throw this.legacyLayout(join(project, legacy.name));
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(project, entry.name));
  }

  ensureRootEncoding() {
    this.rootEncodingCheck ??= this.checkRootEncoding();
    return this.rootEncodingCheck;
  }

  async checkRootEncoding() {
    for (const project of await this.listProjectDirs()) {
      for (const dir of await this.listSessionDirs(project)) {
        const incompatible = join(dir, `session${logSuffix(this.oppositeCompression())}`);
        if (await this.exists(incompatible)) throw this.encodingMismatch(incompatible);
      }
    }
  }

  async rejectLegacyFlatArtifact(project, id, signal) {
    signal?.throwIfAborted();
    const encoded = encodeSegment(id);
    for (const compression of ["zstd", "none"]) {
      const path = join(project, encoded + logSuffix(compression));
      const artifactExists = await this.exists(path);
      signal?.throwIfAborted();
      if (artifactExists) throw this.legacyLayout(path);
    }
  }

  async rejectOppositeArtifact(cwd, id) {
    const path = this.logPathFor(this.rootFor(cwd), cwd, id, this.oppositeCompression());
    if (await this.exists(path)) throw this.encodingMismatch(path);
  }

  oppositeCompression() {
    return this.compression === "zstd" ? "none" : "zstd";
  }

  encodingMismatch(path) {
    return new Error(`session artifact ${JSON.stringify(path)} uses ${logSuffix(this.oppositeCompression())}, but this backend is configured for compression ${JSON.stringify(this.compression)}; use a separate root or select the matching compression mode`);
  }

  legacyLayout(path) {
    return new Error(`session artifact ${JSON.stringify(path)} uses the unsupported flat-file layout; use a separate root or move it into a project/session directory before loading`);
  }

  async exists(path) {
    try {
      await (await open(path, "r")).close();
      return true;
    } catch (error) {
      if (isENOENT(error)) {
        await this.assertLogParentAllowsAbsence(path);
        return false;
      }
      throw error;
    }
  }

  async assertLogParentAllowsAbsence(path) {
    try {
      const parent = dirname(path);
      if ((await stat(parent)).isDirectory()) return;
      const error = new Error(`ENOTDIR: parent path exists but is not a directory: ${parent}`);
      error.code = "ENOTDIR";
      error.path = parent;
      throw error;
    } catch (error) {
      if (isENOENT(error)) return;
      throw error;
    }
  }

  // ---------- 迁移（move） ----------

  /** 内部↔外部迁移：逐字节复制完整日志，校验 header + 帧结构后删源。仅允许非 live 会话。 */
  async move(sessionId, target) {
    const sessions = this.ctx.sessions;
    if (sessions?.get(sessionId) !== void 0) {
      throw new Error(`cannot move session "${sessionId}" while it is live; end its turn and unload it first`);
    }
    const source = await this.findLog(sessionId);
    if (source === void 0) throw new Error(`session "${sessionId}" not found in any root`);
    const targetRoot = target === "internal"
      ? this.internalRoot
      : this.externalEntryById(target).root;

    const { buffer } = await this.readStableFile(source);
    const rawHeader = await this.headerOf(buffer, sessionId);
    const header = this.remapExternalMeta(rawHeader, source);
    const dest = target === "internal"
      ? logPath(this.internalRoot, rawHeader.cwd, sessionId, this.compression)
      : this.logPathFor(targetRoot, header.cwd, sessionId);
    if (normalizePath(source) === normalizePath(dest)) {
      throw new Error(`session "${sessionId}" is already at the requested location`);
    }

    audit({ event: "move-begin", sessionId, cwd: header.cwd, from: source, to: dest });

    await mkdir(dirname(dest), { recursive: true });
    if (await this.exists(dest)) {
      throw new Error(`refusing to move "${sessionId}": a log already exists at destination "${dest}"`);
    }
    const tmp = await this.writeSyncedTempFile(dest, buffer);
    try {
      await rename(tmp, dest);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }

    // 校验复制结果：header 与帧结构
    const { buffer: copied } = await this.readStableFile(dest);
    const copiedHeader = await this.headerOf(copied, sessionId);
    if (copiedHeader.id !== sessionId) {
      await rm(dest, { force: true });
      throw new Error(`move verification failed: copied header id "${copiedHeader.id}" != "${sessionId}"`);
    }

    await rm(source, { force: true });
    await this.pruneEmptyDirs(source);
    this._listCache.headers = null;
    this.coordinator.preparations.invalidate(sessionId);
    this._locationCache.set(sessionId, dest);
    audit({ event: "move-done", sessionId, from: source, to: dest });
    return { sessionId, from: source, to: dest };
  }

  /** 读取并校验一个日志 buffer 的 header（zstd 首帧 / 明文首行）。 */
  async headerOf(buffer, expectedId) {
    let firstLine;
    if (this.compression === "zstd") {
      const { frames } = scanZstdFrames(buffer);
      if (frames.length === 0) throw new Error("empty or header-less Zstandard session log");
      const plaintext = await decompressZstdFrame(buffer.subarray(frames[0].start, frames[0].end));
      assertZstdHeaderFrame(plaintext);
      firstLine = plaintext.subarray(0, -1).toString("utf8");
    } else {
      const nl = buffer.indexOf(10);
      if (nl === -1) throw new Error("empty or header-less session log");
      firstLine = buffer.subarray(0, nl).toString("utf8");
    }
    const meta = parseHeaderMeta(firstLine);
    if (meta === void 0 || (expectedId !== void 0 && meta.id !== expectedId)) {
      throw new Error(`corrupt session log: invalid header line (expected id "${expectedId}")`);
    }
    return meta;
  }

  /** 尽力清理删源后空出的 session/project 目录（忽略失败）。 */
  async pruneEmptyDirs(source) {
    let dir = dirname(source);
    for (let i = 0; i < 3; i++) {
      const parent = dirname(dir);
      if (parent === dir) break;
      try {
        const entries = await readdir(dir);
        if (entries.length === 0) await rm(dir, { force: true });
        else break;
      } catch {
        break;
      }
      dir = parent;
    }
  }

  // ---------- 状态查询（只读） ----------

  async status() {
    const rows = [];
    rows.push({ id: "internal", root: this.internalRoot, sessions: await this.countRoot(this.internalRoot), external: false });
    for (const e of this.allExternalEntries()) {
      rows.push({ id: e.id, cwdPrefix: e.cwdPrefix, root: e.root, sessions: await this.countRoot(e.root), external: true, dynamic: e.dynamic === true });
    }
    return { enabled: this.config.enabled, internalRoot: this.internalRoot, rows };
  }

  async countRoot(root) {
    let count = 0;
    for (const project of await this.projectDirsIn(root)) {
      for (const dir of await this.listSessionDirs(project)) {
        const path = join(dir, `session${logSuffix(this.compression)}`);
        if (await this.exists(path)) count += 1;
      }
    }
    return count;
  }

  async listExternal(rootId) {
    const entry = this.externalEntryById(rootId);
    const artifacts = await this.listArtifacts();
    return artifacts
      .filter((a) => isInside(a.path, entry.root))
      .map((a) => ({
        id: a.header.id,
        cwd: a.header.cwd,
        createdAt: a.header.createdAt,
        parentSession: a.header.parentSession,
        seedLength: a.header.seedLength,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async gitStatus(rootId) {
    const entry = this.externalEntryById(rootId);
    const root = entry.root;
    const run = promisify(execFile);
    try {
      const { stdout } = await run("git", ["-C", root, "status", "--porcelain=v1", "--short"], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      const trackedChanged = lines.filter((l) => !l.startsWith("??")).length;
      const untracked = lines.filter((l) => l.startsWith("??")).length;
      return { root, isRepo: true, trackedChanged, untracked, total: lines.length };
    } catch (error) {
      return { root, isRepo: false, note: error?.message || String(error) };
    }
  }

  // ---------- 命令 / 工具 ----------

  setupExtensions() {
    if (this.config.registerCommand) {
      this._commandFiber = this.ctx.inject(["commands", "userQuestions"], (child) => {
        this.registerCommand(child);
      });
      this.ctx.effect(() => () => this._commandFiber?.dispose());
    }
    if (this.config.registerTools) {
      this._toolFiber = this.ctx.inject(["tools", "userQuestions"], (child) => {
        this.registerTools(child);
      });
      this.ctx.effect(() => () => this._toolFiber?.dispose());
    }
    if (this.config.registerWeb) {
      this._webFiber = this.ctx.inject(["webServer"], (child) => {
        this.registerRoutes(child);
      });
      this.ctx.effect(() => () => this._webFiber?.dispose());
    }
  }

  /** 注册 Client 可调用的只读/写 HTTP 路由（webServer 前缀/exact 路由）。 */
  registerRoutes(child) {
    const server = child.webServer;
    child.effect(() => {
      const disposers = [];
      const json = (res, status, body) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(body));
      };
      const readBody = (req) => new Promise((resolveBody) => {
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => { data += chunk; });
        req.on("end", () => {
          try { resolveBody(data ? JSON.parse(data) : {}); } catch { resolveBody({}); }
        });
      });
      const route = (method, path, handler) => {
        disposers.push(server.register({
          kind: "exact",
          path,
          handler: async (req, res) => {
            try {
              if (req.method !== method) { json(res, 405, { error: "method not allowed" }); return; }
              const body = await readBody(req);
              await handler(req, res, body);
            } catch (error) {
              json(res, 400, { error: error?.message || String(error) });
            }
          },
        }));
      };
      route("GET", "/external-session/config", (req, res) => {
        json(res, 200, {
          enabled: this.config.enabled,
          internalRoot: this.internalRoot,
          entries: this.allExternalEntries().map((e) => ({ id: e.id, cwdPrefix: e.cwdPrefix, root: e.root, dynamic: e.dynamic === true })),
        });
      });
      route("POST", "/external-session/import", (req, res, body) => {
        const entry = this.addExternalEntry(body || {});
        json(res, 200, { ok: true, entry });
      });
      route("GET", "/external-session/sessions", async (req, res) => {
        const query = new URL(req.url, "http://x").searchParams;
        const entryId = query.get("entryId");
        if (!entryId) throw new Error("entryId is required");
        json(res, 200, { items: await this.listExternal(entryId) });
      });
      route("POST", "/external-session/remove", (req, res, body) => {
        this.removeExternalEntry(String(body?.id ?? ""));
        json(res, 200, { ok: true });
      });
      route("GET", "/external-session/external", async (req, res) => {
        const query = new URL(req.url, "http://x").searchParams;
        const sessionId = query.get("sessionId");
        const cwd = query.get("cwd") || "";
        const entry = sessionId
          ? await this.externalEntryForSession(sessionId)
          : this.externalEntryFor(cwd);
        json(res, 200, { sessionId, cwd, external: entry !== null, entryId: entry?.id ?? null, root: entry?.root ?? null });
      });
      return () => { for (const d of disposers) d(); };
    });
  }

  registerCommand(child) {
    const commands = child.commands;
    child.effect(() => {
      let disposer;
      disposer = commands.register({
        name: "external-session",
        description: "Manage external (project-local) session storage: status/list/move/git-status/help.",
        input: { hint: "<status|list|move|git-status|help> [args]" },
        handler: (invocation) => this.handleCommand(child, invocation),
      });
      return () => { try { if (typeof disposer === "function") disposer(); } catch { /* ignore */ } };
    });
  }

  registerTools(child) {
    const tools = child.tools;
    child.effect(() => {
      let d1;
      let d2;
      d1 = tools.register(defineTool({
        name: "external_session_status",
        description: "Read-only report of external session roots: each root's path, session count, and whether it is external.",
        parameters: {},
        output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: () => this.status(),
      }));
      d2 = tools.register(defineTool({
        name: "external_session_move",
        description: "Migrate a persisted (non-live) session between the internal root and an external root by id. Confirmation-gated.",
        parameters: {
          session_id: { type: "string", required: true, description: "The session id to migrate." },
          target: { type: "string", required: true, description: "'internal' or an external root id (e.g. 'rsprojects-dsh')." },
        },
        output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
        execute: async (args, exec) => {
          await this.confirmMove(child, exec, `Move session ${args.session_id} to ${args.target}? This copies the full log, verifies it, then deletes the source.`);
          return this.move(args.session_id, args.target);
        },
      }));
      return () => {
        try { if (typeof d1 === "function") d1(); } catch { /* ignore */ }
        try { if (typeof d2 === "function") d2(); } catch { /* ignore */ }
      };
    });
  }

  /** 写操作确认门：经 userQuestions，无回答者抛 NO_PROVIDER 失败关闭。 */
  async confirmMove(child, exec, question) {
    const uq = child.userQuestions ?? this.ctx.get("userQuestions");
    if (uq === void 0) throw new Error("no user-questions provider available; move aborted (fail closed)");
    const result = await uq.ask({
      questions: [{
        id: "confirm",
        header: "Confirm move",
        question,
        options: [{ label: "Proceed" }, { label: "Cancel" }],
      }],
      ...(exec?.agent !== void 0 ? { agent: exec.agent } : {}),
      signal: exec?.signal,
    });
    const answer = result.answers?.[0];
    const proceed = Array.isArray(answer?.selected) && answer.selected.includes("Proceed");
    if (!proceed) throw new Error("move cancelled by user");
  }

  async handleCommand(child, invocation) {
    const raw = (invocation.rawInput || "").trim();
    const [sub, ...rest] = raw.split(/\s+/).filter(Boolean);
    switch (sub) {
      case "help":
      case undefined:
      case "":
        return { kind: "success", text: this.helpText() };
      case "status": {
        const s = await this.status();
        return { kind: "success", text: this.renderStatus(s) };
      }
      case "list": {
        const rootId = rest[0];
        if (rootId && rootId !== "internal") {
          const sessions = await this.listExternal(rootId);
          return { kind: "success", text: `external root ${JSON.stringify(rootId)}: ${sessions.length} session(s)\n` + sessions.map((s) => `  ${s.id}  cwd=${s.cwd ?? ""}`).join("\n") };
        }
        const artifacts = await this.listArtifacts();
        return { kind: "success", text: `${artifacts.length} session(s)\n` + artifacts.map((a) => `  ${a.header.id}  cwd=${a.header.cwd ?? ""}`).join("\n") };
      }
      case "move": {
        const sessionId = rest[0];
        const target = rest[1];
        if (!sessionId || !target) return { kind: "error", text: "usage: /external-session move <sessionId> <internal|rootId>" };
        await this.confirmMove(child, null, `Move session ${sessionId} to ${target}? This copies the full log, verifies it, then deletes the source.`);
        const r = await this.move(sessionId, target);
        return { kind: "success", text: `moved ${r.sessionId}\n  from: ${r.from}\n  to:   ${r.to}` };
      }
      case "git-status": {
        const rootId = rest[0];
        if (!rootId) return { kind: "error", text: "usage: /external-session git-status <rootId>" };
        const g = await this.gitStatus(rootId);
        return { kind: "success", text: JSON.stringify(g, null, 2) };
      }
      default:
        return { kind: "error", text: `unknown subcommand ${JSON.stringify(sub)}\n` + this.helpText() };
    }
  }

  helpText() {
    return [
      "/external-session status",
      "    list every root, its path, and its session count (read-only).",
      "/external-session list [<rootId>]",
      "    list external sessions (read-only).",
      "/external-session move <sessionId> <internal|rootId>",
      "    migrate a non-live session between internal and external storage (confirmation-gated).",
      "/external-session git-status <rootId>",
      "    read-only git status of an external root's repository (no commit/push).",
      "/external-session help",
      "    this help.",
    ].join("\n");
  }

  renderStatus(s) {
    const lines = [`enabled=${s.enabled}`, `internalRoot=${s.internalRoot}`];
    for (const row of s.rows) {
      lines.push(`  ${row.id.padEnd(10)} ${row.external ? "external" : "internal"}  sessions=${row.sessions}  root=${row.root}`);
    }
    return lines.join("\n");
  }
}

export { Config, RoutedJsonlPersistence, RoutedJsonlPersistence as default, assertPathSafe, decodePortableProjectKey, encodeSegment, fromHeaderLine, isInside, logPath, normalizePath, parseHeaderMeta, portableProjectKey, projectDir, projectKey, scanZstdFrames, sessionDir, toHeaderLine };
