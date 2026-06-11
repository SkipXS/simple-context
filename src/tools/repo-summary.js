import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_BYTES, MAX_LINES } from "../constants.js";
import { formatOutput } from "../output.js";
import { runProcess } from "../process.js";
import { recordStats } from "../stats.js";
import { savingsMeta, validateInteger } from "./shared.js";

export async function repoSummaryTool(args) {
  const { maxLines = MAX_LINES, maxBytes = MAX_BYTES } = args ?? {};
  const lineLimit = validateInteger(maxLines, "context_repo_summary maxLines", 10, 200);
  const byteLimit = validateInteger(maxBytes, "context_repo_summary maxBytes", 1024, MAX_BYTES);
  const started = Date.now();
  const root = process.cwd();
  const lines = [`Project: ${root}`];

  const packageJson = await readJsonIfExists(path.join(root, "package.json"));
  if (packageJson) {
    lines.push(`Name: ${packageJson.name ?? "(unnamed)"}`);
    if (packageJson.version) lines.push(`Version: ${packageJson.version}`);
    if (packageJson.type) lines.push(`Module type: ${packageJson.type}`);
    if (packageJson.main) lines.push(`Entry: ${packageJson.main}`);
    if (packageJson.bin) lines.push(`Bin: ${typeof packageJson.bin === "string" ? packageJson.bin : Object.keys(packageJson.bin).join(", ")}`);
    if (packageJson.engines?.node) lines.push(`Node: ${packageJson.engines.node}`);
    if (packageJson.scripts) lines.push(`Scripts: ${Object.keys(packageJson.scripts).join(", ")}`);
    lines.push(`Dependencies: ${Object.keys(packageJson.dependencies ?? {}).length} runtime, ${Object.keys(packageJson.devDependencies ?? {}).length} dev`);
  }

  const readme = await readTextIfExists(path.join(root, "README.md"));
  if (readme) lines.push("", "README preview:", ...readme.split("\n").slice(0, 8));

  const configs = ["package.json", "tsconfig.json", "vite.config.js", "eslint.config.js", ".gitignore", "opencode.json", "opencode.jsonc"]
    .filter((name) => fs.existsSync(path.join(root, name)));
  if (configs.length > 0) lines.push("", `Config files: ${configs.join(", ")}`);

  try {
    const gitFiles = await runProcess("git", ["ls-files"], { cwd: root, timeout: 30_000 });
    if (gitFiles.code === 0) lines.push(`Tracked files: ${gitFiles.stdout.split("\n").filter(Boolean).length}`);
  } catch {}

  const formatted = formatOutput(lines.join("\n"), lineLimit, byteLimit);
  const meta = { totalLines: formatted.totalLines, totalBytes: formatted.totalBytes, ...savingsMeta(formatted), truncated: formatted.truncated, durationMs: Date.now() - started };
  await recordStats("context_repo_summary", meta);

  return { content: [{ type: "text", text: formatted.text }], _meta: meta };
}

async function readTextIfExists(filePath) {
  try { return await fs.promises.readFile(filePath, "utf8"); } catch { return undefined; }
}

async function readJsonIfExists(filePath) {
  try { return JSON.parse(await fs.promises.readFile(filePath, "utf8")); } catch { return undefined; }
}
