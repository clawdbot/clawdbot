import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { getFinishedSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool, createProcessTool, execTool, processTool } from "./bash-tools.js";
import { buildDockerExecArgs } from "./bash-tools.shared.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";
// PowerShell: Start-Sleep for delays, ; for command separation, $null for null device
const shortDelayCmd = isWin ? "Start-Sleep -Milliseconds 50" : "sleep 0.05";
const yieldDelayCmd = isWin ? "Start-Sleep -Milliseconds 200" : "sleep 0.2";
const longDelayCmd = isWin ? "Start-Sleep -Seconds 2" : "sleep 2";
// Both PowerShell and bash use ; for command separation
const joinCommands = (commands: string[]) => commands.join("; ");
const echoAfterDelay = (message: string) => joinCommands([shortDelayCmd, `echo ${message}`]);
const echoLines = (lines: string[]) => joinCommands(lines.map((line) => `echo ${line}`));
const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCompletion(sessionId: string) {
  let status = "running";
  const deadline = Date.now() + (process.platform === "win32" ? 8000 : 2000);
  while (Date.now() < deadline && status === "running") {
    const poll = await processTool.execute("call-wait", {
      action: "poll",
      sessionId,
    });
    status = (poll.details as { status: string }).status;
    if (status === "running") {
      await sleep(20);
    }
  }
  return status;
}

beforeEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

describe("exec tool backgrounding", () => {
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    if (!isWin) process.env.SHELL = "/bin/bash";
  });

  afterEach(() => {
    if (!isWin) process.env.SHELL = originalShell;
  });

  it(
    "backgrounds after yield and can be polled",
    async () => {
      const result = await execTool.execute("call1", {
        command: joinCommands([yieldDelayCmd, "echo done"]),
        yieldMs: 10,
      });

      expect(result.details.status).toBe("running");
      const sessionId = (result.details as { sessionId: string }).sessionId;

      let status = "running";
      let output = "";
      const deadline = Date.now() + (process.platform === "win32" ? 8000 : 2000);

      while (Date.now() < deadline && status === "running") {
        const poll = await processTool.execute("call2", {
          action: "poll",
          sessionId,
        });
        status = (poll.details as { status: string }).status;
        const textBlock = poll.content.find((c) => c.type === "text");
        output = textBlock?.text ?? "";
        if (status === "running") {
          await sleep(20);
        }
      }

      expect(status).toBe("completed");
      expect(output).toContain("done");
    },
    isWin ? 15_000 : 5_000,
  );

  it("supports explicit background", async () => {
    const result = await execTool.execute("call1", {
      command: echoAfterDelay("later"),
      background: true,
    });

    expect(result.details.status).toBe("running");
    const sessionId = (result.details as { sessionId: string }).sessionId;

    const list = await processTool.execute("call2", { action: "list" });
    const sessions = (list.details as { sessions: Array<{ sessionId: string }> }).sessions;
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);
  });

  it("derives a session name from the command", async () => {
    const result = await execTool.execute("call1", {
      command: "echo hello",
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;
    await sleep(25);

    const list = await processTool.execute("call2", { action: "list" });
    const sessions = (list.details as { sessions: Array<{ sessionId: string; name?: string }> })
      .sessions;
    const entry = sessions.find((s) => s.sessionId === sessionId);
    expect(entry?.name).toBe("echo hello");
  });

  it("uses default timeout when timeout is omitted", async () => {
    const customBash = createExecTool({ timeoutSec: 1, backgroundMs: 10 });
    const customProcess = createProcessTool();

    const result = await customBash.execute("call1", {
      command: longDelayCmd,
      background: true,
    });

    const sessionId = (result.details as { sessionId: string }).sessionId;
    let status = "running";
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline && status === "running") {
      const poll = await customProcess.execute("call2", {
        action: "poll",
        sessionId,
      });
      status = (poll.details as { status: string }).status;
      if (status === "running") {
        await sleep(50);
      }
    }

    expect(status).toBe("failed");
  });

  it("rejects elevated requests when not allowed", async () => {
    const customBash = createExecTool({
      elevated: { enabled: true, allowed: false, defaultLevel: "off" },
      messageProvider: "telegram",
      sessionKey: "agent:main:main",
    });

    await expect(
      customBash.execute("call1", {
        command: "echo hi",
        elevated: true,
      }),
    ).rejects.toThrow("Context: provider=telegram session=agent:main:main");
  });

  it("does not default to elevated when not allowed", async () => {
    const customBash = createExecTool({
      elevated: { enabled: true, allowed: false, defaultLevel: "on" },
      backgroundMs: 1000,
      timeoutSec: 5,
    });

    const result = await customBash.execute("call1", {
      command: "echo hi",
    });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("hi");
  });

  it("logs line-based slices and defaults to last lines", async () => {
    const result = await execTool.execute("call1", {
      command: echoLines(["one", "two", "three"]),
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;

    const status = await waitForCompletion(sessionId);

    const log = await processTool.execute("call3", {
      action: "log",
      sessionId,
      limit: 2,
    });
    const textBlock = log.content.find((c) => c.type === "text");
    expect(normalizeText(textBlock?.text)).toBe("two\nthree");
    expect((log.details as { totalLines?: number }).totalLines).toBe(3);
    expect(status).toBe("completed");
  });

  it("supports line offsets for log slices", async () => {
    const result = await execTool.execute("call1", {
      command: echoLines(["alpha", "beta", "gamma"]),
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;
    await waitForCompletion(sessionId);

    const log = await processTool.execute("call2", {
      action: "log",
      sessionId,
      offset: 1,
      limit: 1,
    });
    const textBlock = log.content.find((c) => c.type === "text");
    expect(normalizeText(textBlock?.text)).toBe("beta");
  });

  it("scopes process sessions by scopeKey", async () => {
    const bashA = createExecTool({ backgroundMs: 10, scopeKey: "agent:alpha" });
    const processA = createProcessTool({ scopeKey: "agent:alpha" });
    const bashB = createExecTool({ backgroundMs: 10, scopeKey: "agent:beta" });
    const processB = createProcessTool({ scopeKey: "agent:beta" });

    const resultA = await bashA.execute("call1", {
      command: shortDelayCmd,
      background: true,
    });
    const resultB = await bashB.execute("call2", {
      command: shortDelayCmd,
      background: true,
    });

    const sessionA = (resultA.details as { sessionId: string }).sessionId;
    const sessionB = (resultB.details as { sessionId: string }).sessionId;

    const listA = await processA.execute("call3", { action: "list" });
    const sessionsA = (listA.details as { sessions: Array<{ sessionId: string }> }).sessions;
    expect(sessionsA.some((s) => s.sessionId === sessionA)).toBe(true);
    expect(sessionsA.some((s) => s.sessionId === sessionB)).toBe(false);

    const pollB = await processB.execute("call4", {
      action: "poll",
      sessionId: sessionA,
    });
    expect(pollB.details.status).toBe("failed");
  });
});

describe("exec notifyOnExit", () => {
  it("enqueues a system event when a backgrounded exec exits", async () => {
    const tool = createExecTool({
      allowBackground: true,
      backgroundMs: 0,
      notifyOnExit: true,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      command: echoAfterDelay("notify"),
      background: true,
    });

    expect(result.details.status).toBe("running");
    const sessionId = (result.details as { sessionId: string }).sessionId;

    let finished = getFinishedSession(sessionId);
    const deadline = Date.now() + (isWin ? 8000 : 2000);
    while (!finished && Date.now() < deadline) {
      await sleep(20);
      finished = getFinishedSession(sessionId);
    }

    expect(finished).toBeTruthy();
    const events = peekSystemEvents("agent:main:main");
    expect(events.some((event) => event.includes(sessionId.slice(0, 8)))).toBe(true);
  });
});

describe("exec PATH handling", () => {
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;

  beforeEach(() => {
    if (!isWin) process.env.SHELL = "/bin/bash";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    if (!isWin) process.env.SHELL = originalShell;
  });

  it("prepends configured path entries", async () => {
    const basePath = isWin ? "C:\\Windows\\System32" : "/usr/bin";
    const prepend = isWin ? ["C:\\custom\\bin", "C:\\oss\\bin"] : ["/custom/bin", "/opt/oss/bin"];
    process.env.PATH = basePath;

    const tool = createExecTool({ pathPrepend: prepend });
    const result = await tool.execute("call1", {
      command: isWin ? "Write-Output $env:PATH" : "echo $PATH",
    });

    const text = normalizeText(result.content.find((c) => c.type === "text")?.text);
    expect(text).toBe([...prepend, basePath].join(path.delimiter));
  });
});

describe("buildDockerExecArgs", () => {
  it("prepends custom PATH after login shell sourcing to preserve both custom and system tools", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        PATH: "/custom/bin:/usr/local/bin:/usr/bin",
        HOME: "/home/user",
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(args).toContain("CLAWDBOT_PREPEND_PATH=/custom/bin:/usr/local/bin:/usr/bin");
    expect(commandArg).toContain('export PATH="${CLAWDBOT_PREPEND_PATH}:$PATH"');
    expect(commandArg).toContain("echo hello");
    expect(commandArg).toBe(
      'export PATH="${CLAWDBOT_PREPEND_PATH}:$PATH"; unset CLAWDBOT_PREPEND_PATH; echo hello',
    );
  });

  it("does not interpolate PATH into the shell command", () => {
    const injectedPath = "$(touch /tmp/moltbot-path-injection)";
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        PATH: injectedPath,
        HOME: "/home/user",
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(args).toContain(`CLAWDBOT_PREPEND_PATH=${injectedPath}`);
    expect(commandArg).not.toContain(injectedPath);
    expect(commandArg).toContain("CLAWDBOT_PREPEND_PATH");
  });

  it("does not add PATH export when PATH is not in env", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo hello",
      env: {
        HOME: "/home/user",
      },
      tty: false,
    });

    const commandArg = args[args.length - 1];
    expect(commandArg).toBe("echo hello");
    expect(commandArg).not.toContain("export PATH");
  });

  it("includes workdir flag when specified", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "pwd",
      workdir: "/workspace",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(args).toContain("-w");
    expect(args).toContain("/workspace");
  });

  it("uses login shell for consistent environment", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "echo test",
      env: { HOME: "/home/user" },
      tty: false,
    });

    expect(args).toContain("sh");
    expect(args).toContain("-lc");
  });

  it("includes tty flag when requested", () => {
    const args = buildDockerExecArgs({
      containerName: "test-container",
      command: "bash",
      env: { HOME: "/home/user" },
      tty: true,
    });

    expect(args).toContain("-t");
  });
});
