import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { COMMAND_SHELL_NAME, DEFAULT_BYTES, MAX_BYTES, MAX_LINES, projectKeyForPath } from "../constants.js";
import { formatOutput } from "../output.js";
import { runProcess } from "../process.js";
import { recordStats } from "../stats.js";
import { displayPath, formatTruncationReason, invalidParams, savingsMeta, toolTextResult, truncationMeta, validateCommandPolicy, validateInteger, withResponseMeta } from "./shared.js";

export const DEFAULT_ENV_TOOLS = Object.freeze(["git", "node", "npm", "pnpm", "yarn", "python", "python3", "go", "ruby", "bundle", "rg"]);

const TOOL_TIMEOUT_MS = 1_500;
const VERSION_OUTPUT_BYTES = 16 * 1024;
const VERSION_ARGS = Object.freeze({
  git: ["--version"],
  node: ["--version"],
  npm: ["--version"],
  pnpm: ["--version"],
  yarn: ["--version"],
  python: ["--version"],
  python3: ["--version"],
  go: ["version"],
  ruby: ["--version"],
  bundle: ["--version"],
  rg: ["--version"],
});

export async function envTool(args) {
  const { tools = DEFAULT_ENV_TOOLS, includePath = false, maxLines = MAX_LINES, maxBytes = DEFAULT_BYTES } = args ?? {};
  const requestedTools = validateTools(tools);
  if (typeof includePath !== "boolean") invalidParams("env includePath must be a boolean");
  const lineLimit = validateInteger(maxLines, "env maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "env maxBytes", 1024, MAX_BYTES);

  const started = Date.now();
  const cwd = process.cwd();
  const packageInfo = await readPackageInfo(cwd);
  const projectRoot = packageInfo?.root ?? displayPath(projectKeyForPath(cwd) ?? cwd);
  const pathEntries = pathEnvEntries();
  const toolResults = await Promise.all(requestedTools.map((tool) => inspectTool(tool, pathEntries)));

  const text = formatEnvText({ cwd, projectRoot, packageInfo, toolResults, includePath, pathEntries });
  const formatted = formatOutput(text, lineLimit, byteLimit);
  const truncated = formatted.truncated;
  const meta = withResponseMeta({
    cwd,
    projectRoot,
    platform: process.platform,
    arch: process.arch,
    shell: COMMAND_SHELL_NAME,
    packageJson: packageInfo?.path,
    packageManagers: packageInfo?.packageManagers,
    scripts: packageInfo?.scripts,
    includePath,
    pathEntryCount: pathEntries.length,
    tools: toolResults,
    totalLines: formatted.totalLines,
    totalBytes: formatted.totalBytes,
    ...savingsMeta(formatted),
    truncated,
    ...truncationMeta(truncated, formatTruncationReason(formatted, lineLimit, byteLimit), "Increase maxLines/maxBytes."),
    durationMs: Date.now() - started,
  });
  await recordStats("env", meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

function validateTools(value) {
  if (!Array.isArray(value)) invalidParams("env tools must be an array");
  if (value.length < 1) invalidParams("env tools must contain at least 1 item");
  if (value.length > 50) invalidParams("env tools must contain at most 50 items");

  const seen = new Set();
  const tools = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") invalidParams(`env tools[${index}] must be a non-empty string`);
    const tool = entry.trim();
    if (!/^[\w@.+-]+$/.test(tool)) invalidParams(`env tools[${index}] must be a command name without path separators or arguments`);
    const key = process.platform === "win32" ? tool.toLowerCase() : tool;
    if (!seen.has(key)) {
      seen.add(key);
      tools.push(tool);
    }
  }
  return tools;
}

async function inspectTool(name, pathEntries) {
  validateCommandPolicy(name, "env");
  const resolvedPath = await findExecutable(name, pathEntries);
  if (!resolvedPath) return { name, available: false };

  return { name, available: true, path: resolvedPath, ...(await toolVersion(name, resolvedPath)) };
}

async function toolVersion(name, executablePath) {
  const args = VERSION_ARGS[name] ?? ["--version"];
  try {
    const result = await runProcess(executablePath, args, {
      timeout: TOOL_TIMEOUT_MS,
      maxBytes: VERSION_OUTPUT_BYTES,
      windowsCommandShim: true,
    });
    if (result.timedOut) return { versionError: "timed_out" };
    if (result.outputTooLarge) return { versionError: "output_too_large" };
    const output = `${result.stdout}\n${result.stderr}`.trim();
    return { version: firstVersionLine(output) };
  } catch {
    return { versionError: "failed" };
  }
}

function firstVersionLine(output) {
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

async function findExecutable(name, pathEntries) {
  const candidates = executableCandidates(name);
  for (const directory of pathEntries) {
    for (const candidate of candidates) {
      const filePath = path.join(directory, candidate);
      if (await isExecutable(filePath)) return filePath;
    }
  }
  return undefined;
}

function executableCandidates(name) {
  if (process.platform !== "win32") return [name];
  const lowerName = name.toLowerCase();
  const hasExtension = path.extname(lowerName) !== "";
  if (hasExtension) return [name];
  const extensions = String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension.toLowerCase()}`), ...extensions.map((extension) => `${name}${extension.toUpperCase()}`)];
}

async function isExecutable(filePath) {
  try {
    await fs.promises.access(filePath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function pathEnvEntries() {
  return String(process.env.PATH ?? process.env.Path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function readPackageInfo(startDir) {
  const packagePath = findUp(startDir, "package.json");
  if (!packagePath) return undefined;

  try {
    const packageJson = JSON.parse(await fs.promises.readFile(packagePath, "utf8"));
    const root = path.dirname(packagePath);
    return {
      path: displayPath(packagePath),
      root: displayPath(root),
      packageManager: typeof packageJson.packageManager === "string" ? packageJson.packageManager : undefined,
      packageManagers: await detectPackageManagers(root, packageJson),
      scripts: packageJson.scripts && typeof packageJson.scripts === "object" && !Array.isArray(packageJson.scripts)
        ? Object.keys(packageJson.scripts).sort()
        : [],
    };
  } catch {
    return { path: displayPath(packagePath), root: displayPath(path.dirname(packagePath)), packageManagers: [], scripts: [], parseError: true };
  }
}

function findUp(startDir, fileName) {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function detectPackageManagers(root, packageJson) {
  const managers = new Set();
  if (typeof packageJson.packageManager === "string") managers.add(packageJson.packageManager.split("@")[0]);
  const lockFiles = [
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
  ];
  await Promise.all(lockFiles.map(async ([fileName, manager]) => {
    try {
      const stat = await fs.promises.stat(path.join(root, fileName));
      if (stat.isFile()) managers.add(manager);
    } catch {
      // Absent lock files are expected.
    }
  }));
  return [...managers].sort();
}

function formatEnvText({ cwd, projectRoot, packageInfo, toolResults, includePath, pathEntries }) {
  const lines = [
    "Environment:",
    `- cwd: ${cwd}`,
    `- projectRoot: ${projectRoot}`,
    `- platform: ${process.platform} ${process.arch} (${os.type()} ${os.release()})`,
    `- shell: ${COMMAND_SHELL_NAME}`,
    "",
    "Package:",
  ];

  if (packageInfo) {
    lines.push(`- package.json: ${packageInfo.path}`);
    if (packageInfo.parseError) lines.push("- parseError: true");
    lines.push(`- packageManager: ${packageInfo.packageManager ?? "(not declared)"}`);
    lines.push(`- detectedManagers: ${packageInfo.packageManagers.length > 0 ? packageInfo.packageManagers.join(", ") : "(none)"}`);
    lines.push(`- scripts: ${packageInfo.scripts.length > 0 ? packageInfo.scripts.join(", ") : "(none)"}`);
  } else {
    lines.push("- package.json: (not found)");
  }

  lines.push("", "Tools:");
  for (const tool of toolResults) {
    lines.push(`- ${tool.name}: ${tool.available ? "available" : "missing"}`);
    lines.push(`  path: ${tool.path ?? "(not found)"}`);
    lines.push(`  version: ${tool.version ?? "(unknown)"}`);
    if (tool.versionError) lines.push(`  versionError: ${tool.versionError}`);
  }

  if (includePath) {
    lines.push("", "PATH:");
    for (const entry of pathEntries) lines.push(`- ${entry}`);
  }

  return lines.join("\n");
}
