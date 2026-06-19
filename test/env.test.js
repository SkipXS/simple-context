process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const childProcess = await import("node:child_process");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { describe, it } = await import("node:test");
const { callTool, tools } = await import("../src/tools.js");

await describe("sc-env", async () => {
  await it("reports default environment and tool output shape", async () => {
    const result = await callTool("sc-env", { maxLines: 200 });
    const text = result.content[0].text;

    assert.match(text, /Environment:/);
    assert.match(text, /Tools:/);
    assert.match(text, /- cwd:/);
    assert.match(text, /- projectRoot:/);
    assert.match(text, /- platform:/);
    assert.match(text, /- shell:/);
    assert.equal(result._meta.cwd, process.cwd());
    assert.equal(result._meta.tools.length, 11);
    assert.deepEqual(result._meta.tools.map((tool) => tool.name), ["git", "node", "npm", "pnpm", "yarn", "python", "python3", "go", "ruby", "bundle", "rg"]);
    for (const tool of result._meta.tools) {
      assert.equal(typeof tool.name, "string");
      assert.equal(typeof tool.available, "boolean");
      if (tool.available) assert.equal(typeof tool.path, "string");
    }
  });

  await it("honors a custom bare command-name tools list and includePath", async () => {
    const result = await callTool("sc-env", { tools: ["node", "definitely-missing-sc-env-tool"], includePath: true, maxLines: 200 });
    const text = result.content[0].text;

    assert.deepEqual(result._meta.tools.map((tool) => tool.name), ["node", "definitely-missing-sc-env-tool"]);
    assert.equal(result._meta.tools[0].available, true);
    assert.equal(result._meta.tools[1].available, false);
    assert.equal(result._meta.includePath, true);
    assert.ok(result._meta.pathEntryCount > 0);
    assert.match(text, /PATH:/);
    assert.match(text, /- node: available/);
    assert.match(text, /- definitely-missing-sc-env-tool: missing/);
  });

  await it("falls back to Path when PATH is unset for tool discovery", async () => {
    await withTempProject(async (dir) => {
      const binDir = path.join(dir, "bin");
      const commandName = "sc-env-path-fallback-probe";
      await fs.mkdir(binDir);
      const executablePath = await writeVersionCommand(binDir, commandName, "sc-env-path-fallback 1.0.0");

      const previousPath = process.env.PATH;
      const previousPathKey = process.env.Path;
      const hadPath = Object.hasOwn(process.env, "PATH");
      const hadPathKey = Object.hasOwn(process.env, "Path");
      try {
        delete process.env.PATH;
        process.env.Path = binDir;

        const result = await callTool("sc-env", { tools: [commandName], includePath: true, maxLines: 80 });
        const tool = result._meta.tools[0];

        assert.equal(tool.name, commandName);
        assert.equal(tool.available, true);
        assert.equal(path.normalize(tool.path), path.normalize(executablePath));
        assert.equal(tool.version, "sc-env-path-fallback 1.0.0");
        assert.equal(result._meta.pathEntryCount, 1);
        assert.match(result.content[0].text, /PATH:/);
        assert.match(result.content[0].text, /sc-env-path-fallback-probe: available/);
      } finally {
        if (hadPath) process.env.PATH = previousPath;
        else delete process.env.PATH;
        if (hadPathKey) process.env.Path = previousPathKey;
        else delete process.env.Path;
      }
    });
  });

  await it("detects package.json managers and scripts from the current project", async () => {
    await withTempProject(async (dir) => {
      await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
        packageManager: "pnpm@9.0.0",
        scripts: { test: "node --test", build: "node build.js" },
      }), "utf8");
      await fs.writeFile(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

      const result = await callTool("sc-env", { tools: ["node"], maxLines: 120 });
      const text = result.content[0].text;

      assert.equal(result._meta.projectRoot, dir);
      assert.equal(result._meta.packageJson, path.join(dir, "package.json"));
      assert.deepEqual(result._meta.packageManagers, ["pnpm"]);
      assert.deepEqual(result._meta.scripts, ["build", "test"]);
      assert.match(text, /packageManager: pnpm@9\.0\.0/);
      assert.match(text, /detectedManagers: pnpm/);
      assert.match(text, /scripts: build, test/);
    });
  });

  await it("enforces command execution disable and allowlist policy in child processes", async () => {
    const disabled = runEnvPolicyProbe({ SIMPLE_CONTEXT_DISABLE_COMMAND_TOOLS: "1" }, ["node"]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /env is disabled by SIMPLE_CONTEXT_DISABLE_COMMAND_TOOLS/);

    const disallowed = runEnvPolicyProbe({ SIMPLE_CONTEXT_COMMAND_ALLOWLIST: "git" }, ["node"]);
    assert.equal(disallowed.status, 0, disallowed.stderr);
    assert.match(disallowed.stdout, /env command is not allowed by SIMPLE_CONTEXT_COMMAND_ALLOWLIST/);
  });

  await it("caps noisy version probe output at the small probe limit", async () => {
    await withTempProject(async (dir) => {
      const commandName = "noisy-sc-env-probe";
      await writeNoisyCommand(dir, commandName);
      const previousPath = process.env.PATH;
      try {
        process.env.PATH = `${dir}${path.delimiter}${previousPath ?? ""}`;
        const result = await callTool("sc-env", { tools: [commandName], maxLines: 80, maxBytes: 4096 });
        const tool = result._meta.tools[0];

        assert.equal(tool.name, commandName);
        assert.equal(tool.available, true);
        assert.equal(tool.version, undefined);
        assert.equal(tool.versionError, "output_too_large");
        assert.match(result.content[0].text, /versionError: output_too_large/);
        assert.doesNotMatch(result.content[0].text, /x{1000}/);
      } finally {
        process.env.PATH = previousPath;
      }
    });
  });

  await it("advertises registry schema and validates bounded arguments", async () => {
    const envTool = tools.tools.find((tool) => tool.name === "sc-env");

    assert.ok(envTool);
    assert.equal(envTool.inputSchema.properties.tools.type, "array");
    assert.equal(envTool.inputSchema.properties.tools.maxItems, 50);
    assert.match(envTool.description, /execute PATH version commands/);
    assert.match(envTool.inputSchema.properties.tools.description, /Bare command names/);
    assert.match(envTool.inputSchema.properties.tools.description, /version-probe from PATH/);
    assert.equal(envTool.inputSchema.properties.includePath.type, "boolean");
    assert.equal(envTool.inputSchema.properties.maxLines.maximum, 500);
    assert.equal(envTool.inputSchema.properties.maxBytes.minimum, 1024);

    await assert.rejects(
      () => callTool("sc-env", { tools: [] }),
      /sc-env tools must contain at least 1 item/,
    );
    await assert.rejects(
      () => callTool("sc-env", { tools: ["node --version"] }),
      /env tools\[0\] must be a command name without path separators or arguments/,
    );
  });
});

function runEnvPolicyProbe(extraEnv, requestedTools) {
  const source = `
    import { callTool } from ${JSON.stringify(new URL("../src/tools.js", import.meta.url).href)};
    try {
      await callTool("sc-env", { tools: ${JSON.stringify(requestedTools)} });
      console.log("resolved");
    } catch (error) {
      console.log(error.message);
    }
  `;
  return childProcess.spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SIMPLE_CONTEXT_USAGE_LOG: "0",
      SIMPLE_CONTEXT_STATS: "0",
      SIMPLE_CONTEXT_DISABLE_COMMAND_TOOLS: "",
      SIMPLE_CONTEXT_DISABLE_RUN: "",
      SIMPLE_CONTEXT_COMMAND_ALLOWLIST: "",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

async function writeNoisyCommand(dir, commandName) {
  if (process.platform === "win32") {
    const filePath = path.join(dir, `${commandName}.cmd`);
    await fs.writeFile(filePath, `@echo off\r\n"${process.execPath}" -e "process.stdout.write('x'.repeat(20000))"\r\n`, "utf8");
    return;
  }

  const filePath = path.join(dir, commandName);
  await fs.writeFile(filePath, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(20000));\n`, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function writeVersionCommand(dir, commandName, versionOutput) {
  if (process.platform === "win32") {
    const filePath = path.join(dir, `${commandName}.cmd`);
    await fs.writeFile(filePath, `@echo off\r\necho ${versionOutput}\r\n`, "utf8");
    return filePath;
  }

  const filePath = path.join(dir, commandName);
  await fs.writeFile(filePath, `#!${process.execPath}\nconsole.log(${JSON.stringify(versionOutput)});\n`, "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

async function withTempProject(callback) {
  const previousCwd = process.cwd();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sc-env-"));
  try {
    process.chdir(dir);
    return await callback(dir);
  } finally {
    process.chdir(previousCwd);
    await rmWithRetries(dir);
  }
}

async function rmWithRetries(target) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error.code !== "EBUSY" && error.code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  await fs.rm(target, { recursive: true, force: true });
}
