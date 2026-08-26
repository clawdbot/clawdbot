import { afterEach, expect, test } from "vitest";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { findTaskByRunId } from "../tasks/task-registry-query.js";
import { getFinishedSession, getSession, markBackgrounded } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
}

function currentNodeEvalCommand(source: string): string {
  const node = shellQuote(process.execPath);
  const script = shellQuote(source);
  return process.platform === "win32" ? `& ${node} -e ${script}` : `${node} -e ${script}`;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

const SYNTHETIC_FINALIZER_CREDENTIAL = ["sk", "synthetic", "fixture", "never", "real"].join("-");

test.skipIf(process.platform === "win32").each([
  {
    name: "post-exit finalizer failure",
    child: 'setTimeout(() => { process.stdout.write("REAL_CHILD_OUTPUT"); process.exit(0); }, 80)',
    timeoutSec: 5,
    finalizerError: `REAL_FINALIZER_DIAGNOSTIC Authorization: Bearer ${SYNTHETIC_FINALIZER_CREDENTIAL}`,
    expectedStatus: "failed",
    expectedExitCode: undefined,
    expectedExitLabel: "unknown exit code",
  },
  {
    name: "normal nonzero child exit",
    child: 'setTimeout(() => { process.stdout.write("REAL_CHILD_OUTPUT"); process.exit(7); }, 80)',
    timeoutSec: 5,
    finalizerError: undefined,
    expectedStatus: "completed",
    expectedExitCode: 7,
    expectedExitLabel: "code 7",
  },
  {
    name: "timeout after a clean child exit",
    child:
      'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("REAL_CHILD_OUTPUT"); setInterval(() => {}, 1000)',
    timeoutSec: 1,
    finalizerError: undefined,
    expectedStatus: "failed",
    expectedExitCode: 0,
    expectedExitLabel: "code 0",
  },
] as const)(
  "keeps $name truthful across a real background child, notification, and waiting poll",
  async ({
    name,
    child,
    timeoutSec,
    finalizerError,
    expectedStatus,
    expectedExitCode,
    expectedExitLabel,
  }) => {
    const scopeKey = `agent:main:process-terminal-${name.replaceAll(" ", "-")}`;
    const run = await runExecProcess({
      command: `real-process-terminal-${name}`,
      workdir: process.cwd(),
      env: {},
      sandbox: {
        containerName: "process-terminal-proof",
        workspaceDir: process.cwd(),
        containerWorkdir: process.cwd(),
        async buildExecSpec() {
          return {
            argv: [process.execPath, "-e", child],
            env: {},
            stdinMode: "pipe-closed",
          };
        },
        async finalizeExec() {
          if (finalizerError) {
            throw new Error(finalizerError);
          }
        },
      },
      usePty: false,
      warnings: [],
      maxOutput: 10_000,
      pendingMaxOutput: 10_000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: true,
      sessionKey: scopeKey,
      scopeKey,
      timeoutSec,
    });
    markBackgrounded(run.session);

    const processTool = createProcessTool({ scopeKey });
    const pendingPoll = processTool.execute(`process-terminal-poll-${name}`, {
      action: "poll",
      sessionId: run.session.id,
      timeout: 2_000,
    });

    const outcome = await run.promise;
    const notification = peekSystemEventEntries(scopeKey)[0]?.text;
    let poll = await pendingPoll;
    if ((poll.details as { status?: string }).status === "running") {
      expect(poll.details).toMatchObject({
        status: "running",
        sessionId: run.session.id,
        aggregated: "REAL_CHILD_OUTPUT",
      });
      expect(textContent(poll)).toContain("REAL_CHILD_OUTPUT");
      poll = await processTool.execute(`process-terminal-final-poll-${name}`, {
        action: "poll",
        sessionId: run.session.id,
      });
    }
    const details = poll.details as { status?: string; exitCode?: number };

    expect(outcome.status).toBe(expectedStatus);
    expect(details.status).toBe(expectedStatus);
    expect(details.exitCode).toBe(expectedExitCode);
    expect(getFinishedSession(run.session.id)?.status).toBe(expectedStatus);
    expect(textContent(poll)).toContain(`Process exited with ${expectedExitLabel}.`);
    expect(notification).toContain(expectedExitLabel);
    if (finalizerError) {
      expect(textContent(poll)).toContain("REAL_FINALIZER_DIAGNOSTIC");
      expect(notification).toContain("REAL_FINALIZER_DIAGNOSTIC");
      expect(textContent(poll)).not.toContain(SYNTHETIC_FINALIZER_CREDENTIAL);
      expect(notification).not.toContain(SYNTHETIC_FINALIZER_CREDENTIAL);
      expect(getFinishedSession(run.session.id)?.aggregated).not.toContain(
        SYNTHETIC_FINALIZER_CREDENTIAL,
      );
      expect(notification).not.toContain("code 0");
    }
  },
);

test("rejects malformed direct actions before requiring a session id", async () => {
  const result = await createProcessTool().execute("invalid-process-action", {
    action: {},
  } as never);

  expect(textContent(result)).toContain("Invalid process action");
  expect(textContent(result)).not.toContain("sessionId is required");
  expect(result.details).toMatchObject({ status: "failed" });
});

test.skipIf(process.platform === "win32").each([
  { name: "quiet successful exit", exitCode: 0, output: "", expectsNotification: false },
  { name: "quiet nonzero exit", exitCode: 7, output: "", expectsNotification: true },
  { name: "nonzero exit with output", exitCode: 7, output: "VISIBLE", expectsNotification: true },
])(
  "preserves default completion wake behavior for a real $name",
  async ({ name, exitCode, output, expectsNotification }) => {
    const scopeKey = `agent:main:process-default-wake-${name.replaceAll(" ", "-")}`;
    const execTool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      backgroundMs: 0,
      timeoutSec: 10,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      sessionKey: scopeKey,
      scopeKey,
    });
    const script = `process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode});`;
    const started = await execTool.execute(`process-default-wake-${name}`, {
      command: currentNodeEvalCommand(script),
      background: true,
    });
    const sessionId = (started.details as { sessionId?: string }).sessionId;
    expect(sessionId).toEqual(expect.any(String));
    if (!sessionId) {
      throw new Error("exec did not return a background session id");
    }

    await expect
      .poll(() => getFinishedSession(sessionId), { timeout: 5_000, interval: 25 })
      .toBeDefined();
    expect(findTaskByRunId(`exec:${sessionId}`)?.status).toBe(
      exitCode === 0 ? "succeeded" : "failed",
    );
    const events = peekSystemEventEntries(scopeKey);
    expect(events).toHaveLength(expectsNotification ? 1 : 0);
    if (expectsNotification) {
      expect(events[0]?.text).toContain(`code ${exitCode}`);
      if (output) {
        expect(events[0]?.text).toContain(output);
      }
    }
  },
);

test.skipIf(process.platform === "win32")(
  "consumes a real notify-on-exit event when process poll returns the terminal result",
  async () => {
    const scopeKey = "agent:main:process-notify-poll";
    const execTool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      backgroundMs: 0,
      timeoutSec: 10,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: true,
      sessionKey: scopeKey,
      scopeKey,
    });
    const processTool = createProcessTool({ scopeKey });
    const marker = "REAL_NOTIFY_ON_EXIT";
    const started = await execTool.execute("process-notify-start", {
      command: currentNodeEvalCommand(`process.stdout.write(${JSON.stringify(marker)});`),
      background: true,
    });
    expect(started.details).toMatchObject({ status: "running" });
    const sessionId = (started.details as { sessionId?: string }).sessionId;
    expect(sessionId).toEqual(expect.any(String));
    if (!sessionId) {
      throw new Error("exec did not return a background session id");
    }

    await expect
      .poll(() => peekSystemEventEntries(scopeKey).some((event) => event.text.includes(marker)), {
        timeout: 5_000,
        interval: 25,
      })
      .toBe(true);

    const poll = await processTool.execute("process-notify-poll", {
      action: "poll",
      sessionId,
    });
    expect(poll.details).toMatchObject({ status: "completed", sessionId });
    expect(peekSystemEventEntries(scopeKey)).toHaveLength(0);
  },
);

test.skipIf(process.platform === "win32")(
  "controls and cancels one real interactive background child through process tools",
  async () => {
    const scopeKey = "agent:main:process-control-roundtrip";
    const execTool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: true,
      backgroundMs: 0,
      timeoutSec: 10,
      notifyOnExit: false,
      scopeKey,
    });
    const processTool = createProcessTool({ scopeKey });
    const command = currentNodeEvalCommand(
      [
        'process.stdin.setEncoding("utf8");',
        "process.stdin.setRawMode?.(true);",
        'let pending = "";',
        "let lineCount = 0;",
        'process.stdout.write("READY\\n");',
        'process.stdin.on("data", (chunk) => {',
        "  for (const char of chunk) {",
        '    if (char === "\\u0003") {',
        "      process.stdout.write(`CONTROL:CTRL-C:${lineCount}\\n`);",
        "      continue;",
        "    }",
        '    if (char !== "\\r" && char !== "\\n") {',
        "      pending += char;",
        "      continue;",
        "    }",
        "    if (!pending) continue;",
        "    lineCount += 1;",
        "    process.stdout.write(`LINE:${pending}\\n`);",
        '    pending = "";',
        "  }",
        "});",
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );

    let sessionId: string | undefined;
    try {
      const started = await execTool.execute("process-control-start", {
        command,
        background: true,
        pty: true,
      });
      expect(started.details).toMatchObject({ status: "running" });
      sessionId = (started.details as { sessionId?: string }).sessionId;
      expect(sessionId).toEqual(expect.any(String));
      if (!sessionId) {
        throw new Error("exec did not return a background session id");
      }

      const listed = await processTool.execute("process-control-list", { action: "list" });
      expect(listed.details).toMatchObject({
        status: "completed",
        sessions: expect.arrayContaining([
          expect.objectContaining({
            sessionId,
            status: "running",
            stdinWritable: true,
          }),
        ]),
      });

      await expect
        .poll(
          async () => {
            const log = await processTool.execute("process-control-ready-log", {
              action: "log",
              sessionId,
            });
            return textContent(log);
          },
          { timeout: 5_000, interval: 25 },
        )
        .toContain("READY");

      const readyPoll = await processTool.execute(
        "process-control-ready-poll",
        { action: "poll", sessionId, timeout: 30_000 },
        AbortSignal.timeout(1_000),
      );
      expect(readyPoll.details).toMatchObject({
        status: "running",
        sessionId,
        aggregated: expect.stringContaining("READY"),
      });

      const write = await processTool.execute("process-control-write", {
        action: "write",
        sessionId,
        data: "alpha",
      });
      expect(write.details).toMatchObject({ status: "running", sessionId });
      expect(textContent(write)).toContain("Wrote 5 bytes");

      const beforeSubmit = await processTool.execute("process-control-before-submit", {
        action: "log",
        sessionId,
      });
      expect(textContent(beforeSubmit)).not.toContain("LINE:alpha");

      const submit = await processTool.execute("process-control-submit", {
        action: "submit",
        sessionId,
      });
      expect(submit.details).toMatchObject({ status: "running", sessionId });
      expect(textContent(submit)).toContain("Submitted");

      await expect
        .poll(
          async () => {
            const poll = await processTool.execute("process-control-alpha-poll", {
              action: "poll",
              sessionId,
              timeout: 250,
            });
            return (poll.details as { aggregated?: string }).aggregated ?? "";
          },
          { timeout: 5_000, interval: 25 },
        )
        .toContain("LINE:alpha");

      const literal = await processTool.execute("process-control-send-literal", {
        action: "send-keys",
        sessionId,
        literal: "beta",
      });
      expect(literal.details).toMatchObject({ status: "running", sessionId });
      expect(textContent(literal)).toContain("Sent 4 bytes");

      const enter = await processTool.execute("process-control-send-enter", {
        action: "send-keys",
        sessionId,
        keys: ["Enter"],
      });
      expect(enter.details).toMatchObject({ status: "running", sessionId });

      await expect
        .poll(
          async () => {
            const poll = await processTool.execute("process-control-beta-poll", {
              action: "poll",
              sessionId,
              timeout: 250,
            });
            return (poll.details as { aggregated?: string }).aggregated ?? "";
          },
          { timeout: 5_000, interval: 25 },
        )
        .toContain("LINE:beta");

      const interrupt = await processTool.execute("process-control-send-interrupt", {
        action: "send-keys",
        sessionId,
        keys: ["C-c"],
      });
      expect(interrupt.details).toMatchObject({ status: "running", sessionId });
      await expect
        .poll(
          async () => {
            const log = await processTool.execute("process-control-interrupt-log", {
              action: "log",
              sessionId,
            });
            return textContent(log);
          },
          { timeout: 5_000, interval: 25 },
        )
        .toContain("CONTROL:CTRL-C:2");

      const killed = await processTool.execute("process-control-kill", {
        action: "kill",
        sessionId,
      });
      expect(textContent(killed)).toBe(`Termination requested for session ${sessionId}.`);
      // A performed kill must not read as a failed tool call.
      expect(killed.details).toMatchObject({ status: "completed" });

      await expect
        .poll(
          async () => {
            const poll = await processTool.execute("process-control-final-poll", {
              action: "poll",
              sessionId,
              timeout: 250,
            });
            const details = poll.details as {
              status?: string;
              exitReason?: string;
              aggregated?: string;
            };
            return {
              status: details.status,
              exitReason: details.exitReason,
              aggregated: details.aggregated ?? "",
            };
          },
          { timeout: 5_000, interval: 25 },
        )
        .toEqual({
          status: "failed",
          exitReason: "manual-cancel",
          aggregated: expect.stringContaining("CONTROL:CTRL-C:2"),
        });

      const completedLog = await processTool.execute("process-control-completed-log", {
        action: "log",
        sessionId,
      });
      expect(completedLog.details).toMatchObject({ status: "failed", sessionId });
      expect(textContent(completedLog)).toContain("LINE:alpha");
      expect(textContent(completedLog)).toContain("LINE:beta");
      expect(textContent(completedLog)).toContain("CONTROL:CTRL-C:2");
    } finally {
      if (sessionId && getSession(sessionId)) {
        await processTool.execute("process-control-cleanup", {
          action: "kill",
          sessionId,
        });
      }
    }
  },
  20_000,
);
