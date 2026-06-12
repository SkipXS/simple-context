import { MAX_BYTES } from "../constants.js";
import { diffTool } from "./diff.js";
import { fetchTool } from "./fetch.js";
import { filesTool } from "./files.js";
import { logsTool } from "./logs.js";
import { outlineTool } from "./outline.js";
import { readTool } from "./read.js";
import { repoSummaryTool } from "./repo-summary.js";
import { runTool } from "./run.js";
import { searchTool } from "./search.js";
import { treeTool } from "./tree.js";
import { usageTool } from "./usage.js";
import { recordUsage } from "../usage.js";

export const tools = {
  tools: [
    {
      name: "context_run",
      description:
        "Run a shell command and return only stdout. Large output is automatically truncated to head+tail (default 60 lines). Use this instead of bash when you don't need every line of output.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max lines before truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "context_logs",
      description:
        "Run a shell command and extract relevant log/error blocks instead of returning plain head+tail output. Non-zero exits return normal tool results with exit metadata.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          maxBlocks: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            description: "Maximum error/log blocks to show. Default: 10.",
          },
          contextLines: {
            type: "integer",
            minimum: 0,
            maximum: 20,
            description: "Lines of context before and after each matched log line. Default: 5.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max output lines before head+tail truncation. Default: 120.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
        },
        required: ["command"],
      },
    },
    {
      name: "context_read",
      description:
        "Read one or more local UTF-8 text files and return bounded previews. Use path for one file or paths for up to 20 files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Single file path to read." },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "string" },
            description: "Multiple file paths to read. Maximum 20. Do not combine with path.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max lines before truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
          fromLine: {
            type: "integer",
            minimum: 1,
            description: "First 1-based line to read. Optional.",
          },
          toLine: {
            type: "integer",
            minimum: 1,
            description: "Last 1-based line to read. Optional.",
          },
          maxLinesPerFile: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "For paths: max lines per file. Default: 60.",
          },
          maxBytesPerFile: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "For paths: max bytes per file. Default: 32768.",
          },
          maxTotalBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "For paths: max bytes for the combined response. Default: 32768.",
          },
        },
      },
    },
    {
      name: "context_search",
      description:
        "Search local files with ripgrep and return bounded filename:line:match output. Uses system rg, OpenCode's cached rg, or Pi's cached rg when available.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "File or directory to search. Default: ." },
          include: { type: "string", description: "File glob to include, for example *.js or *.{ts,tsx}" },
          contextLines: { type: "integer", minimum: 0, maximum: 10, description: "Lines before and after each match. Default: 0." },
          maxMatches: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
            description: "Maximum matches before truncation. Default: 100.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max output lines before head+tail truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
        },
        required: ["pattern"],
      },
    },
    {
      name: "context_files",
      description:
        "List tracked project files compactly using git ls-files when available, with bounded output and optional regex filtering. Use this instead of broad recursive file globs.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path to list. Default: ." },
          include: { type: "string", description: "Optional JavaScript regular expression used to filter returned file paths." },
          maxFiles: { type: "integer", minimum: 1, maximum: 5000, description: "Maximum files to show. Default: 500." },
          maxLines: { type: "integer", minimum: 10, maximum: 200, description: "Max output lines before truncation. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Max output bytes before truncation. Default: 32768." },
        },
      },
    },
    {
      name: "context_tree",
      description:
        "Show a bounded directory tree while skipping common heavy directories such as .git and node_modules.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to inspect. Default: ." },
          maxDepth: { type: "integer", minimum: 1, maximum: 10, description: "Maximum directory depth. Default: 3." },
          maxEntries: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum entries to show. Default: 200." },
          maxLines: { type: "integer", minimum: 10, maximum: 200, description: "Max output lines before truncation. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Max output bytes before truncation. Default: 32768." },
        },
      },
    },
    {
      name: "context_repo_summary",
      description:
        "Summarize the current repository from package metadata, README preview, scripts, configs, and tracked-file count.",
      inputSchema: {
        type: "object",
        properties: {
          maxLines: { type: "integer", minimum: 10, maximum: 200, description: "Max output lines before truncation. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Max output bytes before truncation. Default: 32768." },
        },
      },
    },
    {
      name: "context_file_outline",
      description:
        "Return imports, exports, functions, classes, and top-level declarations from a source file without reading the whole file into context.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Source file path to outline." },
          maxSymbols: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum outline entries to show. Default: 200." },
          maxLines: { type: "integer", minimum: 10, maximum: 200, description: "Max output lines before truncation. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Max output bytes before truncation. Default: 32768." },
        },
        required: ["path"],
      },
    },
    {
      name: "context_fetch",
      description:
        "Fetch a URL and return its content as plain text (HTML is stripped to readable text). Large output is automatically truncated to head+tail. Results are cached for 1 hour; use force=true to bypass.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
          force: { type: "boolean", description: "Skip cache. Default: false." },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max lines before truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "context_diff",
      description:
        "Show a compact git diff preview with stat and bounded hunks. Use this instead of raw git diff when reviewing working tree or staged changes.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional file or directory pathspec to diff. Blank values are treated as omitted." },
          mode: { type: "string", enum: ["diff", "status"], description: "Return diff hunks or compact changed-file status. Default: diff." },
          staged: { type: "boolean", description: "Show staged changes with git diff --cached. Default: false." },
          stat: { type: "boolean", description: "Include git diff --stat before hunks. Default: true." },
          maxFiles: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Maximum changed files with hunks to show. Default: 20.",
          },
          maxHunks: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Maximum diff hunks to show. Default: 20.",
          },
          maxLines: {
            type: "integer",
            minimum: 10,
            maximum: 200,
            description: "Max output lines before head+tail truncation. Default: 60.",
          },
          maxBytes: {
            type: "integer",
            minimum: 1024,
            maximum: MAX_BYTES,
            description: "Max output bytes before head+tail truncation. Default: 32768.",
          },
        },
      },
    },
    {
      name: "context_usage",
      description:
        "Show aggregate savings stats or summarize local usage telemetry. Use mode=stats or mode=report.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["stats", "report"], description: "Report type. Default: stats." },
          maxEvents: { type: "integer", minimum: 1, maximum: 10000, description: "Maximum recent usage events to analyze. Default: 1000." },
          maxLines: { type: "integer", minimum: 10, maximum: 200, description: "Max lines before truncation. Default: 60." },
          maxBytes: { type: "integer", minimum: 1024, maximum: MAX_BYTES, description: "Max output bytes before truncation. Default: 32768." },
        },
      },
    },
  ],
};

const handlers = {
  context_run: runTool,
  context_logs: logsTool,
  context_read: readTool,
  context_search: searchTool,
  context_files: filesTool,
  context_tree: treeTool,
  context_repo_summary: repoSummaryTool,
  context_file_outline: outlineTool,
  context_fetch: fetchTool,
  context_diff: diffTool,
  context_usage: usageTool,
};

export async function callTool(name, args) {
  const started = Date.now();
  let result;
  let error;

  try {
    const handler = handlers[name];
    if (handler) {
      result = await handler(args);
      return result;
    }

    error = new Error(`Unknown tool: ${name}`);
    error.code = -32601;
    throw error;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await recordUsage(name, args, result, error, Date.now() - started);
  }
}
