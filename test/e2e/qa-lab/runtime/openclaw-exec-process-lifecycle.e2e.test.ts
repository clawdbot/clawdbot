import { ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { expect, test, vi } from "vitest";
import {
  getActiveBackgroundExecSessionCount,
  listRunningSessions,
} from "../../../../src/agents/bash-process-registry.js";
import { resetProcessRegistryForTests } from "../../../../src/agents/bash-process-registry.test-support.js";
import { createExecTool, createProcessTool } from "../../../../src/agents/bash-tools.js";
import { getProcessSupervisor } from "../../../../src/process/supervisor/index.js";

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
    const missingRunId = `missing-command-${process.pid}`;
    await expect(
      getProcessSupervisor().spawn({
        mode: "child",
        argv: ["/definitely/not/a/real-openclaw-command"],
        env: { OPENCLAW_CHILD_OOM_SCORE_ADJ: "0" },
        runId: missingRunId,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });

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
      timeoutSeconds: 0.05,
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
    const spawnedChildren = new Map<number, ChildProcess>();
    // oxlint-disable-next-line typescript/unbound-method -- Forward with each child's receiver via originalEmit.call(this, ...).
    const originalEmit = ChildProcess.prototype.emit;
    const captureSpawn = vi.spyOn(ChildProcess.prototype, "emit").mockImplementation(function (
      this: ChildProcess,
      event,
      ...args
    ) {
      if (event === "spawn" && this.pid !== undefined) {
        spawnedChildren.set(this.pid, this);
      }
      return originalEmit.call(this, event, ...args);
    });
    let killTarget: ToolResult;
    try {
      const childCommand = nodeEvalCommand(
        `process.stdout.write(${JSON.stringify(killMarker + "\n")});setInterval(() => {}, 1000);`,
      );
      killTarget = await execTool.execute("kill-background", {
        command: process.platform === "win32" ? childCommand : `exec ${childCommand}`,
        background: true,
      });
    } finally {
      captureSpawn.mockRestore();
    }
    const killedSession = requireSession(killTarget);
    cleanupPids.add(killedSession.pid);
    const child = spawnedChildren.get(killedSession.pid);
    if (!child) {
      throw new Error(`missing spawned child ${killedSession.pid}`);
    }
    const handle = (child as ChildProcess & { _handle: { kill: (signal: number) => number } })
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Native kill errno exercises Node's real error path without ending the child.
      ._handle;
    const originalKill = handle.kill;
    const observedErrors: Array<NodeJS.ErrnoException> = [];
    child.on("error", (error) => {
      observedErrors.push(error);
    });
    const errorListenerCount = child.listenerCount("error");

    try {
      handle.kill = () => -constants.errno.EPERM;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        expect(child.kill("SIGTERM")).toBe(false);
        expect(child.listenerCount("error")).toBe(errorListenerCount);
        expect(observedErrors[attempt]).toMatchObject({ code: "EPERM", syscall: "kill" });
        await Promise.resolve();
        expect(listRunningSessions()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: killedSession.sessionId, exited: false }),
          ]),
        );
        expect(getActiveBackgroundExecSessionCount()).toBe(1);
        expect(pidExists(killedSession.pid)).toBe(true);
      }
    } finally {
      handle.kill = originalKill;
    }

    const killed = await processTool.execute("kill-session", {
      action: "kill",
      sessionId: killedSession.sessionId,
    });
    expect(killed.details).toMatchObject({ status: "completed" });
    const killedTerminal = await pollTerminal(processTool, killedSession.sessionId);
    expect(killedTerminal.details).toMatchObject({
      status: "failed",
      exitReason: "manual-cancel",
    });
    await clearFinished(processTool, killedSession.sessionId);
    await expect.poll(() => pidExists(killedSession.pid), POLL_OPTIONS).toBe(false);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
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
    for (const pid of cleanupPids) {
      if (pidExists(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
    await expect.poll(() => [...cleanupPids].filter(pidExists).length, POLL_OPTIONS).toBe(0);
    resetProcessRegistryForTests();
  }
}, 30_000);
