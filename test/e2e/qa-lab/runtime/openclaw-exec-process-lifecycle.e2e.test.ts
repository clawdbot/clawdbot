import { expect, test } from "vitest";
import {
  getActiveBackgroundExecSessionCount,
  listRunningSessions,
} from "../../../../src/agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../../../../src/agents/bash-process-registry.test-support.js";
import { createExecTool, createProcessTool } from "../../../../src/agents/bash-tools.js";

type ExecTool = ReturnType<typeof createExecTool>;
type ProcessTool = ReturnType<typeof createProcessTool>;
type ToolResult = Awaited<ReturnType<ExecTool["execute"]>>;
type ProcessDetails = {
  aggregated?: string;
  exitReason?: string;
  pid?: number;
  sessionId?: string;
  sessions?: Array<{ sessionId: string; status: string }>;
  status?: string;
  timedOut?: boolean;
};

const POLL_OPTIONS = { timeout: 10_000, interval: 25 };

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
}

function nodeEvalCommand(source: string): string {
  const node = shellQuote(process.execPath);
  const script = shellQuote(source);
  return process.platform === "win32" ? `& ${node} -e ${script}` : `${node} -e ${script}`;
}

function requireSession(result: ToolResult): { pid: number; sessionId: string } {
  const details = result.details as ProcessDetails;
  expect(details.status).toBe("running");
  expect(details.sessionId).toEqual(expect.any(String));
  expect(details.pid).toEqual(expect.any(Number));
  return { pid: details.pid as number, sessionId: details.sessionId as string };
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pollTerminal(processTool: ProcessTool, sessionId: string) {
  let terminal: Awaited<ReturnType<ProcessTool["execute"]>> | undefined;
  await expect
    .poll(async () => {
      terminal = await processTool.execute(`poll-${sessionId}`, {
        action: "poll",
        sessionId,
        timeout: 250,
      });
      return (terminal.details as ProcessDetails).status;
    }, POLL_OPTIONS)
    .not.toBe("running");
  if (!terminal) {
    throw new Error(`process ${sessionId} never produced a terminal result`);
  }
  return terminal;
}

async function clearFinished(processTool: ProcessTool, sessionId: string): Promise<void> {
  const cleared = await processTool.execute(`clear-${sessionId}`, {
    action: "clear",
    sessionId,
  });
  expect(cleared.details).toMatchObject({ status: "completed" });
}

test("OpenClaw executes and controls the complete real process lifecycle", async () => {
  resetProcessRegistryForTests();
  const scopeKey = `agent:qa:exec-lifecycle-${process.pid}`;
  const execTool = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    allowBackground: true,
    backgroundMs: 20,
    notifyOnExit: false,
    scopeKey,
  });
  const foregroundExecTool = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    allowBackground: false,
    notifyOnExit: false,
    scopeKey,
  });
  const processTool = createProcessTool({ scopeKey });
  const cleanupPids = new Set<number>();

  try {
    const shellMarker = `shell-route-${process.pid}`;
    const foregroundCommand =
      process.platform === "win32"
        ? `Write-Output -NoNewline ${shellQuote(shellMarker)}; Write-Output -NoNewline "|$env:OPENCLAW_SHELL"`
        : `printf '%s' ${shellQuote(shellMarker)} && printf '|%s' "$OPENCLAW_SHELL"`;
    const foreground = await foregroundExecTool.execute("foreground-shell", {
      command: foregroundCommand,
    });
    expect(foreground.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(textOf(foreground)).toContain(`${shellMarker}|exec`);

    const backgroundStart = `background-start-${process.pid}`;
    const backgroundEnd = `background-end-${process.pid}`;
    const background = await execTool.execute("explicit-background", {
      command: nodeEvalCommand(
        `process.stdout.write(${JSON.stringify(backgroundStart + "\n")});` +
          `setTimeout(() => process.stdout.write(${JSON.stringify(backgroundEnd + "\n")}), 350);`,
      ),
      background: true,
    });
    const backgroundSession = requireSession(background);
    cleanupPids.add(backgroundSession.pid);

    const listed = await processTool.execute("list-background", { action: "list" });
    expect((listed.details as ProcessDetails).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: backgroundSession.sessionId,
          status: "running",
        }),
      ]),
    );

    await expect
      .poll(async () => {
        const log = await processTool.execute("log-background", {
          action: "log",
          sessionId: backgroundSession.sessionId,
        });
        return textOf(log);
      }, POLL_OPTIONS)
      .toContain(backgroundStart);

    const backgroundTerminal = await pollTerminal(processTool, backgroundSession.sessionId);
    expect(backgroundTerminal.details).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect((backgroundTerminal.details as ProcessDetails).aggregated).toContain(backgroundEnd);
    await clearFinished(processTool, backgroundSession.sessionId);
    cleanupPids.delete(backgroundSession.pid);

    const yieldedMarker = `yielded-terminal-${process.pid}`;
    const yielded = await execTool.execute("yielded-background", {
      command: nodeEvalCommand(
        `setTimeout(() => process.stdout.write(${JSON.stringify(yieldedMarker + "\n")}), 350);`,
      ),
      yieldMs: 20,
    });
    const yieldedSession = requireSession(yielded);
    cleanupPids.add(yieldedSession.pid);
    const yieldedTerminal = await pollTerminal(processTool, yieldedSession.sessionId);
    expect(yieldedTerminal.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect((yieldedTerminal.details as ProcessDetails).aggregated).toContain(yieldedMarker);
    await clearFinished(processTool, yieldedSession.sessionId);
    cleanupPids.delete(yieldedSession.pid);

    const timedOut = await foregroundExecTool.execute("foreground-timeout", {
      command: nodeEvalCommand("setTimeout(() => {}, 5000);"),
      timeout: 0.05,
    });
    expect(timedOut.details).toMatchObject({
      status: "failed",
      exitReason: "overall-timeout",
      timedOut: true,
    });
    expect(textOf(timedOut)).toContain("Command timed out after 0.05 seconds.");

    const ptyMarker = `pty-route-${process.pid}`;
    const pty = await foregroundExecTool.execute("foreground-pty", {
      command: nodeEvalCommand(
        `process.stdout.write(${JSON.stringify(ptyMarker + ":")} + String(Boolean(process.stdout.isTTY)) + ":" + (process.env.OPENCLAW_SHELL || ""));`,
      ),
      pty: true,
    });
    expect(pty.details).toMatchObject({ status: "completed", exitCode: 0 });
    expect(textOf(pty)).toContain(`${ptyMarker}:true:exec`);

    const killMarker = `kill-target-${process.pid}`;
    const killTarget = await execTool.execute("kill-background", {
      command: nodeEvalCommand(
        `process.stdout.write(${JSON.stringify(killMarker + "\n")});setInterval(() => {}, 1000);`,
      ),
      background: true,
    });
    const killedSession = requireSession(killTarget);
    cleanupPids.add(killedSession.pid);
    const killed = await processTool.execute("kill-session", {
      action: "kill",
      sessionId: killedSession.sessionId,
    });
    expect(killed.details).toMatchObject({ status: "failed" });
    const killedTerminal = await pollTerminal(processTool, killedSession.sessionId);
    expect(killedTerminal.details).toMatchObject({ status: "failed" });
    await clearFinished(processTool, killedSession.sessionId);
    await expect.poll(() => pidExists(killedSession.pid), POLL_OPTIONS).toBe(false);
    cleanupPids.delete(killedSession.pid);

    const finalList = await processTool.execute("list-final", { action: "list" });
    expect((finalList.details as ProcessDetails).sessions).toEqual([]);
    expect(listRunningSessions().filter((session) => session.scopeKey === scopeKey)).toEqual([]);
    expect(getActiveBackgroundExecSessionCount()).toBe(0);
  } finally {
    for (const session of listRunningSessions().filter((entry) => entry.scopeKey === scopeKey)) {
      await processTool.execute(`cleanup-${session.id}`, {
        action: "remove",
        sessionId: session.id,
      });
    }
    await expect.poll(() => [...cleanupPids].filter(pidExists).length, POLL_OPTIONS).toBe(0);
    resetProcessRegistryForTests();
  }
}, 30_000);
