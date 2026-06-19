import * as fs from "node:fs/promises";
import { DEFAULT_BYTES, DEFAULT_COMMAND_TIMEOUT_MS, MAX_BYTES, MAX_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS } from "../constants.js";
import { formatOutput } from "../output.js";
import { runCommandResult } from "../process.js";
import { recordStats } from "../stats.js";
import { commandStatusLine, combinedCommandOutput, extractLogBlocks } from "./logs.js";
import { formatTruncationReason, invalidParams, savingsForText, toolTextResult, truncationMeta, validateCommandPolicy, validateInteger, withResponseMeta } from "./shared.js";

const NPM_SCRIPT_ORDER = ["check", "verify", "test", "typecheck", "lint"];
const AUTO_MODE_ORDER = ["npm", "go", "python", "ruby"];

export async function validateTool(args) {
  const {
    mode = "auto",
    command,
    maxLines = 120,
    maxBytes = DEFAULT_BYTES,
    timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  } = args ?? {};

  const lineLimit = validateInteger(maxLines, "validate maxLines", 10, 500);
  const byteLimit = validateInteger(maxBytes, "validate maxBytes", 1024, MAX_BYTES);
  const timeoutLimit = validateInteger(timeoutMs, "validate timeoutMs", MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS);

  const selection = await selectValidationCommand({ mode, command });
  if (!selection.command) return await noCommandResult(selection, lineLimit, byteLimit);

  validateCommandPolicy(selection.command, "validate");

  const result = await runCommandResult(selection.command, { timeout: timeoutLimit });
  const outputText = combinedCommandOutput(result);
  const extraction = extractLogBlocks(outputText, 10, 5, lineLimit);
  const header = validationHeader(selection, result);
  const originalText = [header, outputText || "(no output)"].join("\n");
  const previewText = [header, extraction.text].join("\n");
  const formatted = formatOutput(previewText, lineLimit, byteLimit);
  const baseSavings = savingsForText(originalText, formatted.text);
  const totalBytes = Math.max(baseSavings.totalBytes, baseSavings.returnedBytes);
  const savedBytes = Math.max(0, totalBytes - baseSavings.returnedBytes);
  const truncated = extraction.truncated || formatted.truncated || result.outputTooLarge;
  const meta = withResponseMeta({
    totalLines: originalText.split("\n").length,
    sourceBytes: baseSavings.totalBytes,
    totalBytes,
    returnedBytes: baseSavings.returnedBytes,
    savedBytes,
    savedPercent: totalBytes > 0 ? Math.round((savedBytes / totalBytes) * 100) : 0,
    estimatedTokensSaved: Math.ceil(savedBytes / 4),
    truncated,
    ...truncationMeta(truncated, validationTruncationReason(extraction, formatted, result, lineLimit, byteLimit), "Increase maxLines/maxBytes or run sc-logs with the selected command."),
    requestedMode: selection.requestedMode,
    selectedMode: selection.selectedMode,
    command: selection.command,
    commandSource: selection.commandSource,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    outputTooLarge: result.outputTooLarge,
    durationMs: result.durationMs,
    timeoutMs: result.timeoutMs,
    blocksFound: extraction.blocksFound,
    blocksShown: extraction.blocksShown,
    fallback: extraction.fallback,
  });
  await recordStats("validate", meta);

  return toolTextResult(formatted.text, meta, byteLimit);
}

async function selectValidationCommand({ mode, command }) {
  if (command !== undefined && mode !== "custom") {
    invalidParams('sc-validate command is only accepted with mode: "custom". Omit command for auto/npm/go/python/ruby modes.');
  }

  if (typeof command === "string" && command.trim() !== "") {
    return {
      requestedMode: mode,
      selectedMode: "custom",
      command: command.trim(),
      commandSource: "override",
      suggestions: [],
    };
  }

  if (mode === "custom") {
    return noSelection(mode, "custom", ["Pass a safe command override, for example { mode: \"custom\", command: \"npm test\" }."]);
  }

  if (mode === "auto") {
    for (const candidateMode of AUTO_MODE_ORDER) {
      const selection = await commandForMode(candidateMode, mode);
      if (selection.command) return selection;
    }
    return noSelection(mode, undefined, autoSuggestions());
  }

  const selection = await commandForMode(mode, mode);
  return selection.command ? selection : noSelection(mode, mode, suggestionsForMode(mode));
}

async function commandForMode(selectedMode, requestedMode) {
  if (selectedMode === "npm") return await npmCommand(requestedMode);
  if (selectedMode === "go" && await exists("go.mod")) return commandSelection(requestedMode, "go", "go test ./...", "go.mod");
  if (selectedMode === "python" && await hasAny(["pyproject.toml", "pytest.ini", "tox.ini", "setup.cfg", "setup.py"])) return commandSelection(requestedMode, "python", "python -m pytest", "python project file");
  if (selectedMode === "ruby" && await hasAny(["Gemfile", "Rakefile", ".ruby-version"])) {
    if (await exists("Gemfile")) return commandSelection(requestedMode, "ruby", "bundle exec rake test", "Gemfile");
    return commandSelection(requestedMode, "ruby", "ruby -Itest -e \"Dir['test/**/*_test.rb'].each { |f| require_relative f }\"", "ruby project file");
  }
  return noSelection(requestedMode, selectedMode, suggestionsForMode(selectedMode));
}

async function npmCommand(requestedMode) {
  let packageJson;
  try {
    packageJson = JSON.parse(await fs.readFile("package.json", "utf8"));
  } catch {
    return noSelection(requestedMode, "npm", suggestionsForMode("npm"));
  }

  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const script = NPM_SCRIPT_ORDER.find((name) => typeof scripts[name] === "string");
  return script
    ? commandSelection(requestedMode, "npm", `npm run ${script}`, `package.json scripts.${script}`)
    : noSelection(requestedMode, "npm", suggestionsForMode("npm"));
}

function commandSelection(requestedMode, selectedMode, command, commandSource) {
  return { requestedMode, selectedMode, command, commandSource, suggestions: [] };
}

function noSelection(requestedMode, selectedMode, suggestions) {
  return { requestedMode, selectedMode, command: undefined, commandSource: undefined, suggestions };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasAny(filePaths) {
  for (const filePath of filePaths) {
    if (await exists(filePath)) return true;
  }
  return false;
}

function validationHeader(selection, result) {
  return [
    `Validation mode: ${selection.selectedMode}${selection.requestedMode !== selection.selectedMode ? ` (requested ${selection.requestedMode})` : ""}`,
    `Command: ${selection.command}`,
    commandStatusLine(result),
  ].join("\n");
}

async function noCommandResult(selection, maxLines, maxBytes) {
  const lines = [
    `Validation mode: ${selection.selectedMode ?? "none"}${selection.requestedMode !== selection.selectedMode ? ` (requested ${selection.requestedMode})` : ""}`,
    "Command: (none selected)",
    "No validation command found.",
    "Suggestions:",
    ...selection.suggestions.map((suggestion) => `- ${suggestion}`),
  ];
  const text = lines.join("\n");
  const formatted = formatOutput(text, maxLines, maxBytes);
  const savings = savingsForText(text, formatted.text);
  const meta = withResponseMeta({
    totalLines: lines.length,
    totalBytes: savings.totalBytes,
    returnedBytes: savings.returnedBytes,
    savedBytes: savings.savedBytes,
    savedPercent: savings.savedPercent,
    estimatedTokensSaved: savings.estimatedTokensSaved,
    truncated: formatted.truncated,
    ...truncationMeta(formatted.truncated, formatTruncationReason(formatted, maxLines, maxBytes), "Increase maxLines/maxBytes."),
    requestedMode: selection.requestedMode,
    selectedMode: selection.selectedMode,
    command: undefined,
    exitCode: null,
    durationMs: 0,
    status: "no_command",
    suggestions: selection.suggestions,
  });
  await recordStats("validate", meta);
  return toolTextResult(formatted.text, meta, maxBytes);
}

function suggestionsForMode(mode) {
  if (mode === "npm") return [`Add one package.json script named ${NPM_SCRIPT_ORDER.join(", ")}.`, "Or pass mode: custom with a safe command, such as npm test."];
  if (mode === "go") return ["Add go.mod or pass mode: custom with command: go test ./...."];
  if (mode === "python") return ["Add pyproject.toml or pytest.ini, or pass mode: custom with command: python -m pytest."];
  if (mode === "ruby") return ["Add Gemfile/Rakefile, or pass mode: custom with command: bundle exec rake test."];
  return ["Pass mode: npm, go, python, ruby, or mode: custom with a safe command."];
}

function autoSuggestions() {
  return [
    `For npm, add a package.json script named ${NPM_SCRIPT_ORDER.join(", ")}.`,
    "For Go, add go.mod so sc-validate can run go test ./....",
    "For Python, add pyproject.toml or pytest.ini so sc-validate can run python -m pytest.",
    "For Ruby, add Gemfile/Rakefile so sc-validate can run bundle exec rake test.",
    "Or pass mode: custom with a safe command override.",
  ];
}

function validationTruncationReason(extraction, formatted, result, maxLines, maxBytes) {
  const reasons = [];
  if (result.outputTooLarge) reasons.push("command_output_cap");
  if (extraction.truncationReason) reasons.push(extraction.truncationReason);
  if (formatted.truncated) reasons.push(formatTruncationReason(formatted, maxLines, maxBytes));
  return reasons.filter(Boolean).join("+") || "format_limit";
}
