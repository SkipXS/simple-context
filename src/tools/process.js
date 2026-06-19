import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMMAND_SHELL, COMMAND_SHELL_NAME, CACHE_DIR, DEFAULT_BYTES, MAX_BYTES, MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS } from "../constants.js";
import { formatOutput } from "../output.js";
import { recordStats } from "../stats.js";
import { ensurePrivateDir, writeJsonAtomically, withFileLock, PRIVATE_FILE_MODE } from "../storage.js";
import { assertPathAllowed, formatTruncationReason, invalidParams, savingsForText, toolTextResult, truncationMeta, validateCommandPolicy, validateCommandToolsEnabled, validateInteger, withResponseMeta } from "./shared.js";

const PROCESS_DIR = path.join(CACHE_DIR, "processes");
const PROCESS_LOG_DIR = path.join(PROCESS_DIR, "logs");
const PROCESS_REGISTRY_FILE = path.join(PROCESS_DIR, "registry.json");
const DEFAULT_PROCESS_WAIT_MS = 1_000;
const STALE_PROCESS_ENTRY_MS = 24 * 60 * 60 * 1_000;
const ownedProcessIds = new Set();

export async function processTool(args) {
  const { mode = "list" } = args ?? {};
  validateCommandToolsEnabled("process");
  if (mode === "start") return await startProcess(args ?? {});
  if (mode === "list") return await listProcesses(args ?? {});
  if (mode === "status") return await processStatus(args ?? {});
  if (mode === "logs") return await processLogs(args ?? {});
  if (mode === "stop") return await stopProcess(args ?? {});
  invalidParams("process mode must be one of: start, list, status, logs, stop");
}

async function startProcess(args) {
  const {
    command,
    name,
    cwd,
    timeoutMs = DEFAULT_PROCESS_WAIT_MS,
    maxLines = 60,
    maxBytes = DEFAULT_BYTES,
  } = args;
  if (typeof command !== "string" || command.trim() === "") invalidParams("process start requires a non-empty command string");
  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) invalidParams("process name must be a non-empty string");
  const waitLimit = validateInteger(timeoutMs, "process timeoutMs", MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  const lineLimit = validateInteger(maxLines, "process maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "process maxBytes", 1024, MAX_BYTES);
  validateCommandPolicy(command, "process");
  const resolvedCwd = await resolveCwd(cwd);

  await ensurePrivateDir(PROCESS_LOG_DIR);
  const now = Date.now();
  const id = processId(now);
  const logPath = path.join(PROCESS_LOG_DIR, `${id}.log`);
  await fs.promises.writeFile(logPath, "", { mode: PRIVATE_FILE_MODE });
  await fs.promises.chmod(logPath, PRIVATE_FILE_MODE).catch(() => {});
  const logFd = await fs.promises.open(logPath, "a", PRIVATE_FILE_MODE);

  let child;
  try {
    child = spawn(command, {
      cwd: resolvedCwd,
      shell: COMMAND_SHELL,
      detached: process.platform !== "win32",
      stdio: ["ignore", logFd.fd, logFd.fd],
      windowsHide: true,
    });
  } catch (error) {
    await logFd.close().catch(() => {});
    throw error;
  }
  await logFd.close().catch(() => {});

  child.once("close", async (code, signal) => {
    ownedProcessIds.delete(id);
    await markProcessExited(id, code, signal).catch(() => {});
  });
  child.once("error", async (error) => {
    ownedProcessIds.delete(id);
    await fs.promises.appendFile(logPath, `process spawn error: ${error.message}\n`).catch(() => {});
    await markProcessExited(id, null, "error").catch(() => {});
  });
  child.unref();

  const entry = cleanEntry({
    id,
    name: name?.trim(),
    command: command.trim(),
    pid: child.pid,
    cwd: resolvedCwd,
    logPath,
    startedAt: new Date(now).toISOString(),
    status: "running",
    shell: COMMAND_SHELL_NAME,
  });
  ownedProcessIds.add(id);
  await updateRegistry((registry) => {
    registry.processes = pruneStaleProcesses(registry.processes ?? []);
    registry.processes.push(entry);
    return registry;
  });

  await waitForInitialLogOrExit(logPath, child, waitLimit);
  const logPreview = await boundedLog(logPath, lineLimit, byteLimit);
  const rawText = formatStartText(entry, logPreview.text);
  const formatted = formatOutput(rawText, lineLimit, byteLimit);
  const meta = await processMeta("start", rawText, lineLimit, byteLimit, {
    id,
    pid: child.pid,
    logPath,
    cwd: resolvedCwd,
    command: command.trim(),
    name: entry.name,
    alive: isPidAlive(child.pid),
    timeoutMs: waitLimit,
    shell: COMMAND_SHELL_NAME,
    log: logPreview.meta,
  });
  return toolTextResult(formatted.text, meta, byteLimit);
}

async function listProcesses(args) {
  const { maxLines = 60, maxBytes = DEFAULT_BYTES } = args;
  const lineLimit = validateInteger(maxLines, "process maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "process maxBytes", 1024, MAX_BYTES);
  const registry = await loadAndPruneRegistry();
  const entries = registry.processes ?? [];
  const lines = entries.length === 0
    ? ["No sc-process managed processes."]
    : entries.map((entry) => formatProcessLine(withRuntimeState(entry)));
  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const meta = await processMeta("list", formatted.text, lineLimit, byteLimit, {
    count: entries.length,
    processes: entries.map((entry) => summarizeEntry(withRuntimeState(entry))),
  });
  return toolTextResult(formatted.text, meta, byteLimit);
}

async function processStatus(args) {
  const { id, maxLines = 60, maxBytes = DEFAULT_BYTES } = args;
  const entry = await requireEntry(id);
  const lineLimit = validateInteger(maxLines, "process maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "process maxBytes", 1024, MAX_BYTES);
  const runtime = withRuntimeState(entry);
  const lines = [
    `id: ${runtime.id}`,
    runtime.name ? `name: ${runtime.name}` : undefined,
    `status: ${runtime.runtimeStatus}`,
    `pid: ${runtime.pid}`,
    `pidAlive: ${runtime.pidAlive}`,
    `alive: ${runtime.alive}`,
    `startedAt: ${runtime.startedAt}`,
    runtime.stoppedAt ? `stoppedAt: ${runtime.stoppedAt}` : undefined,
    runtime.exitCode !== undefined ? `exitCode: ${runtime.exitCode}` : undefined,
    runtime.signal ? `signal: ${runtime.signal}` : undefined,
    `cwd: ${runtime.cwd}`,
    `logPath: ${runtime.logPath}`,
    `command: ${runtime.command}`,
  ].filter(Boolean);
  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const meta = await processMeta("status", formatted.text, lineLimit, byteLimit, summarizeEntry(runtime));
  return toolTextResult(formatted.text, meta, byteLimit);
}

async function processLogs(args) {
  const { id, maxLines = 120, maxBytes = DEFAULT_BYTES } = args;
  const entry = await requireEntry(id);
  const lineLimit = validateInteger(maxLines, "process maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "process maxBytes", 1024, MAX_BYTES);
  const log = await boundedLog(entry.logPath, lineLimit, byteLimit);
  const meta = await processMeta("logs", log.text, lineLimit, byteLimit, {
    ...summarizeEntry(withRuntimeState(entry)),
    log: log.meta,
  });
  return toolTextResult(log.text, meta, byteLimit);
}

async function stopProcess(args) {
  const { id, timeoutMs = DEFAULT_PROCESS_WAIT_MS, maxLines = 60, maxBytes = DEFAULT_BYTES } = args;
  const entry = await requireEntry(id);
  const waitLimit = validateInteger(timeoutMs, "process timeoutMs", MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);
  const lineLimit = validateInteger(maxLines, "process maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "process maxBytes", 1024, MAX_BYTES);
  const before = withRuntimeState(entry);
  const wasAlive = before.pidAlive;
  let stopped = false;
  let refused = false;
  let status = "stopped";
  if (before.pidAlive && !before.owned) {
    refused = true;
    status = "unverifiable";
  } else if (before.alive) {
    await terminateManagedPid(entry.pid, waitLimit);
    stopped = !isPidAlive(entry.pid);
  }
  const stoppedAt = new Date().toISOString();
  const updated = await updateRegistry((registry) => {
    registry.processes = (registry.processes ?? []).map((candidate) => candidate.id === id
      ? cleanEntry({
        ...candidate,
        status,
        stoppedAt: refused ? candidate.stoppedAt : stoppedAt,
        stopRequestedAt: refused ? candidate.stopRequestedAt : stoppedAt,
        stopRefusedAt: refused ? stoppedAt : candidate.stopRefusedAt,
        stopRefusalReason: refused ? "unverifiable_pid_after_supervisor_restart" : candidate.stopRefusalReason,
      })
      : candidate);
    return registry;
  });
  const runtime = withRuntimeState((updated.processes ?? []).find((candidate) => candidate.id === id) ?? entry);
  const lines = [
    refused
      ? `Process ${id} was not stopped because its live PID cannot be verified as sc-process-owned.`
      : `Process ${id} ${wasAlive ? (stopped ? "stopped" : "stop requested") : "already exited"}.`,
    formatProcessLine(runtime),
  ];
  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const meta = await processMeta("stop", formatted.text, lineLimit, byteLimit, {
    ...summarizeEntry(runtime),
    wasAlive,
    stopped,
    refused,
    refusalReason: refused ? "unverifiable_pid_after_supervisor_restart" : undefined,
    timeoutMs: waitLimit,
  });
  return toolTextResult(formatted.text, meta, byteLimit);
}

async function resolveCwd(cwd) {
  if (cwd === undefined) return process.cwd();
  if (typeof cwd !== "string" || cwd.trim() === "") invalidParams("process cwd must be a non-empty string");
  const resolved = path.resolve(cwd);
  await assertPathAllowed(resolved, "process");
  const stat = await fs.promises.stat(resolved).catch(() => undefined);
  if (!stat?.isDirectory()) invalidParams(`process cwd is not a directory: ${cwd}`);
  return resolved;
}

function processId(now) {
  return `proc-${now.toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

function registryTemplate() {
  return { version: 1, updatedAt: new Date().toISOString(), processes: [] };
}

async function readRegistry() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(PROCESS_REGISTRY_FILE, "utf8"));
    return {
      version: 1,
      ...parsed,
      processes: Array.isArray(parsed.processes) ? parsed.processes.filter((entry) => entry && typeof entry.id === "string") : [],
    };
  } catch {
    return registryTemplate();
  }
}

async function updateRegistry(mutator) {
  return await withFileLock(PROCESS_REGISTRY_FILE, async () => {
    const registry = await readRegistry();
    const next = mutator(registry) ?? registry;
    next.version = 1;
    next.updatedAt = new Date().toISOString();
    await writeJsonAtomically(PROCESS_REGISTRY_FILE, next);
    return next;
  });
}

async function loadAndPruneRegistry() {
  return await updateRegistry((registry) => {
    registry.processes = pruneStaleProcesses(registry.processes ?? []);
    return registry;
  });
}

function pruneStaleProcesses(entries) {
  const cutoff = Date.now() - STALE_PROCESS_ENTRY_MS;
  return entries.filter((entry) => {
    const runtime = withRuntimeState(entry);
    if (runtime.alive) return true;
    const stoppedTime = Date.parse(entry.stoppedAt ?? entry.exitedAt ?? entry.startedAt ?? "");
    return !Number.isFinite(stoppedTime) || stoppedTime >= cutoff;
  });
}

async function requireEntry(id) {
  if (typeof id !== "string" || id.trim() === "") invalidParams("process id is required");
  const registry = await loadAndPruneRegistry();
  const entry = (registry.processes ?? []).find((candidate) => candidate.id === id);
  if (!entry) invalidParams(`Unknown sc-process id: ${id}`);
  return entry;
}

async function markProcessExited(id, code, signal) {
  await updateRegistry((registry) => {
    registry.processes = (registry.processes ?? []).map((entry) => entry.id === id
      ? cleanEntry({ ...entry, status: entry.status === "stopped" ? "stopped" : "exited", exitedAt: new Date().toISOString(), exitCode: code, signal })
      : entry);
    return registry;
  });
}

function cleanEntry(entry) {
  return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function withRuntimeState(entry) {
  const pidAlive = isPidAlive(entry.pid);
  const owned = ownedProcessIds.has(entry.id);
  const alive = pidAlive && owned;
  const runtimeStatus = alive
    ? "running"
    : pidAlive
      ? "unverifiable"
      : entry.status === "stopped"
        ? "stopped"
        : "exited";
  return { ...entry, pidAlive, owned, alive, runtimeStatus };
}

function summarizeEntry(entry) {
  return cleanEntry({
    id: entry.id,
    name: entry.name,
    pid: entry.pid,
    alive: entry.alive,
    pidAlive: entry.pidAlive,
    owned: entry.owned,
    status: entry.runtimeStatus ?? entry.status,
    command: entry.command,
    cwd: entry.cwd,
    logPath: entry.logPath,
    startedAt: entry.startedAt,
    stoppedAt: entry.stoppedAt,
    exitCode: entry.exitCode,
    signal: entry.signal,
  });
}

function formatProcessLine(entry) {
  const namePart = entry.name ? ` ${entry.name}` : "";
  return `${entry.id}${namePart} pid=${entry.pid} status=${entry.runtimeStatus} alive=${entry.alive} pidAlive=${entry.pidAlive} cwd=${entry.cwd}`;
}

async function waitForInitialLogOrExit(logPath, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const size = await fs.promises.stat(logPath).then((stat) => stat.size, () => 0);
    if (size > 0 || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function boundedLog(logPath, maxLines, maxBytes) {
  let text = "";
  let totalBytes = 0;
  try {
    const stat = await fs.promises.stat(logPath);
    totalBytes = stat.size;
    const start = Math.max(0, stat.size - maxBytes * 2);
    const handle = await fs.promises.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    text = "";
  }
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const tailText = lines.slice(-maxLines).join("\n");
  const formatted = formatOutput(tailText, maxLines, maxBytes);
  return {
    text: formatted.text,
    meta: {
      logPath,
      totalBytes,
      returnedBytes: formatted.returnedBytes,
      totalLines: lines.length,
      returnedLines: formatted.totalLines,
      truncated: totalBytes > formatted.returnedBytes || lines.length > formatted.totalLines || formatted.truncated,
    },
  };
}

function formatStartText(entry, initialLogs) {
  return [
    `Started ${entry.id} pid=${entry.pid}`,
    `logPath: ${entry.logPath}`,
    "Initial logs:",
    initialLogs,
  ].join("\n");
}

async function terminateManagedPid(pid, timeoutMs) {
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("error", resolve);
      killer.once("close", resolve);
    });
    await waitForPidExit(pid, timeoutMs);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const exited = await waitForPidExit(pid, Math.min(timeoutMs, 1_000));
  if (!exited) {
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    await waitForPidExit(pid, timeoutMs);
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isPidAlive(pid);
}

async function processMeta(operation, text, maxLines, maxBytes, extra) {
  const formatted = formatOutput(text, maxLines, maxBytes);
  const savings = savingsForText(text, formatted.text);
  const meta = withResponseMeta({
    totalLines: formatted.totalLines,
    totalBytes: savings.totalBytes,
    returnedBytes: savings.returnedBytes,
    savedBytes: savings.savedBytes,
    savedPercent: savings.savedPercent,
    estimatedTokensSaved: savings.estimatedTokensSaved,
    truncated: formatted.truncated,
    ...truncationMeta(formatted.truncated, formatTruncationReason(formatted, maxLines, maxBytes), "Increase maxLines/maxBytes."),
    operation,
    ...extra,
  });
  await recordStats("process", meta);
  return meta;
}
