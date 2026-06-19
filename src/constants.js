import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const SERVER_NAME = "simple-context";
export const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export const MAX_LINES = 60;
export const DEFAULT_BYTES = 32 * 1024;
export const MAX_BYTES = Math.max(DEFAULT_BYTES, normalizeByteLimit(envValue("MAX_RESPONSE_BYTES"), 64 * 1024));
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const MIN_COMMAND_TIMEOUT_MS = 100;
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const MAX_COMMAND_BYTES = normalizeByteLimit(envValue("MAX_COMMAND_BYTES"), 10 * 1024 * 1024);
export const MAX_FETCH_BYTES = normalizeByteLimit(envValue("MAX_FETCH_BYTES"), 10 * 1024 * 1024);
export const MAX_READ_BYTES = normalizeByteLimit(envValue("MAX_READ_BYTES"), 10 * 1024 * 1024);
export const MAX_RPC_LINE_BYTES = normalizeIntegerLimit(envValue("MAX_RPC_LINE_BYTES"), 1024 * 1024, 1024, 100 * 1024 * 1024);
export const MAX_RPC_BATCH_SIZE = normalizeIntegerLimit(envValue("MAX_RPC_BATCH_SIZE"), 50, 1, 10_000);
export const MAX_RPC_BATCH_CONCURRENCY = normalizeIntegerLimit(envValue("MAX_RPC_BATCH_CONCURRENCY"), 4, 1, 1000);
export const MAX_RPC_TOOL_CONCURRENCY = normalizeIntegerLimit(envValue("MAX_RPC_TOOL_CONCURRENCY"), MAX_RPC_BATCH_CONCURRENCY, 1, 1000);
export const MAX_RPC_TOOL_QUEUE = normalizeIntegerLimit(envValue("MAX_RPC_TOOL_QUEUE"), 100, 0, 100_000);
export const MAX_RPC_PENDING_REQUESTS = normalizeIntegerLimit(envValue("MAX_RPC_PENDING_REQUESTS"), 100, 1, 100_000);
export const READ_RANGE_TIMEOUT_MS = normalizeIntegerLimit(envValue("READ_RANGE_TIMEOUT_MS"), 120_000, 1_000, 3_600_000);
export const CACHE_MAX_ENTRIES = normalizeIntegerLimit(envValue("CACHE_MAX_ENTRIES"), 200, 1, 10_000);
export const CACHE_MAX_BYTES = normalizeByteLimit(envValue("CACHE_MAX_BYTES"), 50 * 1024 * 1024);
export const USAGE_LOG_MAX_BYTES = normalizeByteLimit(envValue("USAGE_LOG_MAX_BYTES"), 10 * 1024 * 1024);
export const CACHE_TTL_MS = 3_600_000;
export const ALLOW_NON_HTTP_FETCH = /^(1|true|yes)$/i.test(envValue("ALLOW_NON_HTTP_FETCH") ?? "");
export const DISABLE_COMMAND_TOOLS = envFlag("DISABLE_COMMAND_TOOLS") || envFlag("DISABLE_RUN");
export const COMMAND_ALLOWLIST = envList(envValue("COMMAND_ALLOWLIST"));
export const FETCH_PUBLIC_ONLY = envFlag("FETCH_PUBLIC_ONLY");
export const PATH_ROOTS = envList(envValue("PATH_ROOTS")).map((entry) => path.resolve(entry));

export const COMMAND_SHELL = envValue("SHELL") || true;
export const COMMAND_SHELL_NAME = typeof COMMAND_SHELL === "string"
  ? COMMAND_SHELL
  : process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : process.env.SHELL || "/bin/sh";

export const CACHE_DIR = path.join(os.homedir(), ".simple-context");
export const CACHE_FILE = path.join(CACHE_DIR, "cache.json");
export const STATS_FILE = path.join(CACHE_DIR, "stats.json");
export const USAGE_LOG_FILE = path.join(CACHE_DIR, "usage.jsonl");
export const RG_NAME = process.platform === "win32" ? "rg.exe" : "rg";

const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "deno.json", "deno.jsonc"];

export function projectKey() {
  return projectKeyForPath(process.cwd(), { ignoreTemp: true });
}

export function projectKeyForPath(value, { ignoreTemp = false } = {}) {
  const candidate = canonicalPath(value);
  const startDir = existingDirectoryForProjectKey(candidate);
  const projectRoot = startDir ? findProjectRoot(startDir) : undefined;
  if (projectRoot) return projectRoot;
  return ignoreTemp && isTempPath(candidate) ? undefined : candidate;
}

function existingDirectoryForProjectKey(value) {
  try {
    const stat = fs.statSync(value);
    return stat.isDirectory() ? value : path.dirname(value);
  } catch {
    return undefined;
  }
}

function findProjectRoot(startDir) {
  let current = startDir;
  for (;;) {
    if (PROJECT_MARKERS.some((marker) => fs.existsSync(path.join(current, marker)))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isTempPath(value) {
  const tempRoot = canonicalPath(os.tmpdir());
  const candidate = canonicalPath(value);
  const relative = path.relative(tempRoot, candidate);
  return relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(value) {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function usageLogEnabled() {
  return !/^(0|false|no|off)$/i.test(envValue("USAGE_LOG") ?? "")
    && !/^(1|true|yes|on)$/i.test(envValue("DISABLE_USAGE_LOG") ?? "");
}

export function statsEnabled() {
  return !/^(0|false|no|off)$/i.test(envValue("STATS") ?? "")
    && !/^(1|true|yes|on)$/i.test(envValue("DISABLE_STATS") ?? "");
}

export function envValue(suffix) {
  return process.env[`SIMPLE_CONTEXT_${suffix}`];
}

function envFlag(suffix) {
  return /^(1|true|yes|on)$/i.test(envValue(suffix) ?? "");
}

function envList(value) {
  return String(value ?? "")
    .split(/[\n,;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function normalizeByteLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

export function normalizeIntegerLimit(value, fallback, min, max) {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(parsed, max));
}
