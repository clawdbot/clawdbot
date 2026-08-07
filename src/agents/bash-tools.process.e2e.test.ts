import { afterEach, expect, test } from "vitest";
import { getSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
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

test.skipIf(process.platform === "win32")(
  "controls one real interactive background child through exec and process tools",
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
        "      setTimeout(() => process.exit(lineCount === 2 ? 0 : 3), 10);",
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

      const readyPoll = await processTool.execute("process-control-ready-poll", {
        action: "poll",
        sessionId,
        timeout: 1_000,
      });
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
            const poll = await processTool.execute("process-control-final-poll", {
              action: "poll",
              sessionId,
              timeout: 250,
            });
            const details = poll.details as {
              status?: string;
              exitCode?: number;
              aggregated?: string;
            };
            return {
              status: details.status,
              exitCode: details.exitCode,
              aggregated: details.aggregated ?? "",
            };
          },
          { timeout: 5_000, interval: 25 },
        )
        .toEqual({
          status: "completed",
          exitCode: 0,
          aggregated: expect.stringContaining("CONTROL:CTRL-C:2"),
        });

      const completedLog = await processTool.execute("process-control-completed-log", {
        action: "log",
        sessionId,
      });
      expect(completedLog.details).toMatchObject({ status: "completed", sessionId });
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
