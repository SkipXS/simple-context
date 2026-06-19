process.env.SIMPLE_CONTEXT_USAGE_LOG = "0";
process.env.SIMPLE_CONTEXT_STATS = "0";
process.env.SIMPLE_CONTEXT_MAX_COMMAND_BYTES = "1024";

const assert = await import("node:assert/strict");
const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const { execFile, spawn } = await import("node:child_process");
const { describe, it } = await import("node:test");
const { pathToFileURL } = await import("node:url");

const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), "scl-process-home-"));
process.env.HOME = stateHome;
process.env.USERPROFILE = stateHome;

const { buildWindowsCommandShimCommandLine, runCommand, runProcess } = await import("../src/process.js");
const { callTool } = await import("../src/tools.js");

await describe("Windows command shim invocation", async () => {
  await it("quotes shim paths and args with spaces while escaping cmd metacharacters", () => {
    const commandLine = buildWindowsCommandShimCommandLine("C:\\Program Files\\tools & bins\\runner.cmd", [
      "literal arg",
      "pattern (one)|two",
      "caret^bang!percent%quote\"redir<out>",
    ]);

    assert.equal(
      commandLine,
      "call \"C:\\Program Files\\tools ^& bins\\runner.cmd\" \"literal arg\" \"pattern ^(one^)^|two\" \"caret^^bang^!percent^%quote^\"redir^<out^>\"",
    );
  });

  await it("runs a .cmd shim whose path and arguments contain spaces on Windows", async () => {
    if (process.platform !== "win32") return;

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scl shim spaces-"));
    const shimPath = path.join(tempDir, "shim runner.cmd");
    await fs.writeFile(shimPath, "@echo off\r\necho [%~1] [%~2]\r\n", "utf8");

    const result = await runProcess(shimPath, ["first arg", "second path"], {
      timeout: 5_000,
      windowsCommandShim: true,
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "[first arg] [second path]");
  });
});

await describe("runProcess output caps", async () => {
  await it("honors an optional per-call maxBytes cap", async () => {
    const result = await runProcess(process.execPath, ["--input-type=module", "--eval", "process.stdout.write('x'.repeat(4096))"], {
      timeout: 5_000,
      maxBytes: 512,
    });

    assert.equal(result.outputTooLarge, true);
    assert.ok(result.stdout.length <= 512);
  });
});

await describe("sc-process managed lifecycle", async () => {
  await it("starts, lists, reports, tails logs, and stops a managed process", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scl-process-script-"));
    const scriptPath = path.join(tempDir, "server.mjs");
    await fs.writeFile(scriptPath, [
      "console.log('ready from sc-process');",
      "let n = 0;",
      "setInterval(() => console.log('tick ' + (++n)), 100);",
    ].join("\n"), "utf8");
    const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;

    const started = await callTool("sc-process", { mode: "start", command, name: "unit-server", timeoutMs: 1000, maxLines: 40 });
    const { id, pid, logPath } = started._meta;
    assert.match(id, /^proc-/);
    assert.equal(typeof pid, "number");
    assert.match(started.content[0].text, /Started proc-/);
    assert.match(started.content[0].text, /ready from sc-process/);
    const logStat = await fs.stat(logPath);
    if (process.platform !== "win32") assert.equal(logStat.mode & 0o077, 0);

    const listed = await callTool("sc-process", { mode: "list", maxLines: 80 });
    assert.match(listed.content[0].text, new RegExp(id));
    assert.equal(listed._meta.processes.some((entry) => entry.id === id && entry.alive), true);

    const status = await callTool("sc-process", { mode: "status", id });
    assert.match(status.content[0].text, /status: running/);
    assert.equal(status._meta.id, id);
    assert.equal(status._meta.alive, true);

    const logs = await callTool("sc-process", { mode: "logs", id, maxLines: 20 });
    assert.match(logs.content[0].text, /ready from sc-process/);
    assert.equal(logs._meta.id, id);

    const stopped = await callTool("sc-process", { mode: "stop", id, timeoutMs: 1000 });
    assert.match(stopped.content[0].text, new RegExp(`Process ${id} (stopped|stop requested|already exited)`));
    assert.equal(stopped._meta.id, id);

    const stoppedAgain = await callTool("sc-process", { mode: "stop", id, timeoutMs: 1000 });
    assert.match(stoppedAgain.content[0].text, /already exited|stop requested|stopped/);
  });

  await it("refuses to stop a persisted live PID that is not owned by this supervisor", async () => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      const id = `seeded-${Date.now()}`;
      const registryDir = path.join(stateHome, ".simple-context", "processes");
      const logDir = path.join(registryDir, "logs");
      const logPath = path.join(logDir, `${id}.log`);
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(logPath, "seeded\n", "utf8");
      await fs.writeFile(path.join(registryDir, "registry.json"), JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        processes: [{
          id,
          name: "not-owned",
          command: "seeded external command",
          pid: child.pid,
          cwd: process.cwd(),
          logPath,
          startedAt: new Date().toISOString(),
          status: "running",
        }],
      }, null, 2), "utf8");

      const stopped = await callTool("sc-process", { mode: "stop", id, timeoutMs: 1000 });

      assert.equal(stopped._meta.refused, true);
      assert.equal(stopped._meta.stopped, false);
      assert.equal(stopped._meta.pidAlive, true);
      assert.equal(stopped._meta.alive, false);
      assert.match(stopped.content[0].text, /cannot be verified/);
      assert.equal(isPidAlive(child.pid), true);
    } finally {
      child.kill();
    }
  });

  await it("rejects start commands with the shared command policy", async () => {
    const toolsUrl = pathToFileURL(path.join(process.cwd(), "src", "tools.js")).href;
    const output = await execNode(`
      const { callTool } = await import(${JSON.stringify(toolsUrl)});
      try {
        await callTool("sc-process", { mode: "start", command: "node --version" });
        process.stdout.write(JSON.stringify({ ok: true }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
      }
    `, { SIMPLE_CONTEXT_COMMAND_ALLOWLIST: "echo allowed" });

    const result = JSON.parse(output);
    assert.equal(result.ok, false);
    assert.equal(result.code, -32602);
    assert.match(result.message, /COMMAND_ALLOWLIST/);
  });
});

await describe("runCommand output cap failures", async () => {
  await it("only returns capped output when the command is observed to exit cleanly", async () => {
    const command = nodeScriptCommand(`
      process.stdout.write("x".repeat(4096));
      process.exit(0);
    `);

    try {
      const result = await runCommand(command, { timeout: 5_000, allowOutputTooLarge: true });
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.outputTooLarge, true);
      assert.equal(result.stdout.length, 1024);
    } catch (error) {
      // POSIX process-group termination can win the race against a near-immediate
      // clean exit after the output cap is hit. That must remain an error rather
      // than being reported as a successful tool result.
      assert.equal(error.outputTooLarge, true);
      assert.ok(error.signal || error.status !== 0, `expected signal or non-zero exit, got status=${error.status} signal=${error.signal}`);
    }
  });

  await it("rejects capped commands that exit non-zero instead of reporting success", async () => {
    const command = nodeScriptCommand(`
      process.stdout.write("x".repeat(4096));
      process.exit(7);
    `);

    await assert.rejects(
      () => runCommand(command, { timeout: 5_000, allowOutputTooLarge: true }),
      (error) => {
        assert.equal(error.outputTooLarge, true);
        assert.ok(error.status === 7 || error.signal, `expected exit 7 or signal, got status=${error.status} signal=${error.signal}`);
        return true;
      },
    );
  });

  await it("rejects capped commands terminated by signal instead of reporting success", async () => {
    const command = nodeScriptCommand(`
      process.stdout.write("x".repeat(4096));
      setInterval(() => {}, 1000);
    `);

    await assert.rejects(
      () => runCommand(command, { timeout: 5_000, allowOutputTooLarge: true }),
      (error) => {
        assert.equal(error.outputTooLarge, true);
        assert.ok(error.signal || error.status !== 0, `expected signal or non-zero exit, got status=${error.status} signal=${error.signal}`);
        return true;
      },
    );
  });
});

function nodeScriptCommand(source) {
  return nodeEvalCommand(source);
}

function nodeEvalCommand(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `${shellQuote(process.execPath)} --input-type=module --eval ${shellQuote(`eval(Buffer.from('${encoded}','base64').toString())`)}`;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replaceAll('"', '""')}"`;
  return `'${text.replaceAll("'", "'\\''")}'`;
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
      { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8" },
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
