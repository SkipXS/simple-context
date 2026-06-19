process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { execFile } = await import("node:child_process");
const { describe, it } = await import("node:test");
const { pathToFileURL } = await import("node:url");
const { callTool } = await import("../src/tools.js");

await describe("sc-validate", async () => {
  await it("auto-detects npm and selects the first validation script in order", async () => {
    await withTempCwd(async (cwd) => {
      await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
        scripts: {
          test: "node -e \"require('fs').writeFileSync('test-ran.txt','test')\"",
          check: "node -e \"require('fs').writeFileSync('selected.txt','check')\"",
          lint: "node -e \"require('fs').writeFileSync('lint-ran.txt','lint')\"",
        },
      }), "utf8");

      const result = await callTool("sc-validate", { mode: "auto", maxLines: 80 });
      const text = result.content[0].text;

      assert.match(text, /Validation mode: npm \(requested auto\)/);
      assert.match(text, /Command: npm run check/);
      assert.equal(result._meta.selectedMode, "npm");
      assert.equal(result._meta.command, "npm run check");
      assert.equal(result._meta.exitCode, 0);
      assert.equal(await fs.readFile(path.join(cwd, "selected.txt"), "utf8"), "check");
      await assert.rejects(() => fs.access(path.join(cwd, "test-ran.txt")));
      await assert.rejects(() => fs.access(path.join(cwd, "lint-ran.txt")));
    });
  });

  await it("returns suggestions instead of failing when no command is found", async () => {
    await withTempCwd(async () => {
      const result = await callTool("sc-validate", {});
      const text = result.content[0].text;

      assert.match(text, /Command: \(none selected\)/);
      assert.match(text, /No validation command found/);
      assert.match(text, /package\.json script/);
      assert.equal(result._meta.status, "no_command");
      assert.equal(result._meta.exitCode, null);
    });
  });

  await it("rejects explicit command unless mode is custom", async () => {
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('should-not-run')")}`;

    await assert.rejects(
      () => callTool("sc-validate", { command }),
      (error) => {
        assert.equal(error.code, -32602);
        assert.match(error.message, /command is only accepted with mode: "custom"/);
        return true;
      },
    );

    await assert.rejects(
      () => callTool("sc-validate", { mode: "npm", command }),
      (error) => {
        assert.equal(error.code, -32602);
        assert.match(error.message, /command is only accepted with mode: "custom"/);
        return true;
      },
    );
  });

  await it("returns compact diagnostics for nonzero custom validation commands", async () => {
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.error('Error: boom'); process.exit(2)")}`;

    const result = await callTool("sc-validate", { mode: "custom", command, maxLines: 80 });
    const text = result.content[0].text;

    assert.match(text, /Validation mode: custom/);
    assert.match(text, /Command exit 2/);
    assert.match(text, /Error: boom/);
    assert.equal(result._meta.selectedMode, "custom");
    assert.equal(result._meta.command, command);
    assert.equal(result._meta.commandSource, "override");
    assert.equal(result._meta.exitCode, 2);
  });

  await it("runs custom validation commands through the shared command policy", async () => {
    const toolsUrl = pathToFileURL(path.join(process.cwd(), "src", "tools.js")).href;
    const output = await execNode(`
      const { callTool } = await import(${JSON.stringify(toolsUrl)});
      try {
        await callTool("sc-validate", { mode: "custom", command: "node --version" });
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      }
    `, { SIMPLE_CONTEXT_COMMAND_ALLOWLIST: "npm test" });

    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(result.code, -32602);
    assert.match(result.message, /COMMAND_ALLOWLIST/);
  });

  await it("rejects selected validation commands with the shared command policy", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "scl-validate-policy-"));
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { check: "node --version" },
    }), "utf8");
    const toolsUrl = pathToFileURL(path.join(process.cwd(), "src", "tools.js")).href;

    const output = await execNode(`
      process.chdir(${JSON.stringify(cwd)});
      const { callTool } = await import(${JSON.stringify(toolsUrl)});
      try {
        await callTool("sc-validate", { mode: "auto" });
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      }
    `, { SIMPLE_CONTEXT_COMMAND_ALLOWLIST: "node --version" });

    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(result.code, -32602);
    assert.match(result.message, /COMMAND_ALLOWLIST/);
  });
});

async function withTempCwd(fn) {
  const previous = process.cwd();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "scl-validate-"));
  process.chdir(cwd);
  try {
    await fn(cwd);
  } finally {
    process.chdir(previous);
  }
}

async function execNode(script, env = {}) {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "--eval", `
        process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
        process.env.SIMPLE_CONTEXT_STATS = "0";
        ${script}
      `],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          error.message += `\nstdout:\n${stdout}\nstderr:\n${stderr}`;
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
