import * as os from "node:os";
import * as path from "node:path";

export const SERVER_NAME = "mini-sandbox";
export const SERVER_VERSION = "1.0.0";

export const MAX_LINES = 60;
export const MAX_BYTES = 32 * 1024;
export const MAX_COMMAND_BYTES = 100 * 1024 * 1024;
export const MAX_FETCH_BYTES = normalizeByteLimit(process.env.MINI_SANDBOX_MAX_FETCH_BYTES, 10 * 1024 * 1024);
export const MAX_READ_BYTES = normalizeByteLimit(process.env.MINI_SANDBOX_MAX_READ_BYTES, 10 * 1024 * 1024);
export const CACHE_TTL_MS = 3_600_000;

export const COMMAND_SHELL = process.env.MINI_SANDBOX_SHELL || true;
export const COMMAND_SHELL_NAME = typeof COMMAND_SHELL === "string"
  ? COMMAND_SHELL
  : process.platform === "win32"
    ? process.env.ComSpec || "cmd.exe"
    : process.env.SHELL || "/bin/sh";

export const CACHE_DIR = path.join(os.homedir(), ".mini-sandbox");
export const CACHE_FILE = path.join(CACHE_DIR, "cache.json");
export const RG_NAME = process.platform === "win32" ? "rg.exe" : "rg";

export function normalizeByteLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}
