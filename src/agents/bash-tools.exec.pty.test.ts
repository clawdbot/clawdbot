/**
 * Exec PTY integration tests.
 * Starts PTY sessions, polls them through the process tool, and verifies
 * terminal input/output handling.
 */
import { afterEach, expect, test } from "vitest";
import { markBackgrounded } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

function currentEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
}

function currentNodeEvalCommand(source: string): string {
  const node = shellQuote(process.execPath);
  const script = shellQuote(source);
  return process.platform === "win32" ? `& ${node} -e ${script}` : `${node} -e ${script}`;
}

async function startPtySession(command: string) {
  const processTool = createProcessTool();
  const run = await runExecProcess({
    command,
    workdir: process.cwd(),
    env: currentEnv(),
    usePty: true,
    warnings: [],
    maxOutput: 20_000,
    pendingMaxOutput: 20_000,
    notifyOnExit: false,
    timeoutSec: 5,
  });
  markBackgrounded(run.session);
  return { processTool, sessionId: run.session.id, run };
}

async function expectSessionCompletion(params: {
  processTool: ReturnType<typeof createProcessTool>;
  sessionId: string;
  expectedText: string | string[];
}) {
  const expectedTexts = Array.isArray(params.expectedText)
    ? params.expectedText
    : [params.expectedText];
  await expect
    .poll(
      async () => {
        const poll = await params.processTool.execute("toolcall", {
          action: "poll",
          sessionId: params.sessionId,
        });
        const details = poll.details as { status?: string; aggregated?: string };
        if (details.status === "running") {
          return false;
        }
        expect(details.status).toBe("completed");
        for (const expectedText of expectedTexts) {
          expect(details.aggregated ?? "").toContain(expectedText);
        }
        return true;
      },
      {
        timeout: process.platform === "win32" ? 12_000 : 8_000,
        interval: 30,
      },
    )
    .toBe(true);
}

test("exec supports pty output, OPENCLAW_SHELL, send-keys, and submit", async () => {
  const { processTool, sessionId } = await startPtySession(
    currentNodeEvalCommand(
      [
        "process.stdout.write(`ok:${process.env.OPENCLAW_SHELL || ''}`);",
        "const dataEvent=String.fromCharCode(100,97,116,97);",
        "const submitted=String.fromCharCode(115,117,98,109,105,116,116,101,100);",
        "let first=false;",
        "process.stdin.on(dataEvent,d=>{",
        "process.stdout.write(d);",
        "if(d.includes(10)||d.includes(13)){",
        "if(first){process.stdout.write(submitted);process.exit(0);}",
        "first=true;",
        "}",
        "});",
      ].join(""),
    ),
  );

  await processTool.execute("toolcall", {
    action: "send-keys",
    sessionId,
    keys: ["h", "i", "Enter"],
  });

  await processTool.execute("toolcall", {
    action: "submit",
    sessionId,
  });

  await expectSessionCompletion({
    processTool,
    sessionId,
    expectedText: ["submitted", "ok", "exec"],
  });
});

test.skipIf(process.platform === "win32")(
  "process send-keys delivers Unicode, raw hex, and control bytes through a real PTY",
  async () => {
    const { processTool, sessionId, run } = await startPtySession(
      currentNodeEvalCommand(`
        process.stdin.setRawMode(true);
        const received = [];
        process.stdin.on("data", chunk => {
          received.push(chunk);
          if (chunk.includes(13)) {
            console.log("RECEIVED=" + Buffer.concat(received).toString("hex"));
            process.exit(0);
          }
        });
        console.log("READY");
      `),
    );
    try {
      await expect.poll(() => run.session.aggregated, { timeout: 5_000 }).toContain("READY");
      const result = await processTool.execute("send-mixed-bytes", {
        action: "send-keys",
        sessionId,
        literal: "你好😀",
        hex: ["c3", "a9", "00", "ff"],
        keys: ["C-c", "Enter"],
      });
      const outcome = await run.promise;
      expect(outcome).toMatchObject({ status: "completed", exitCode: 0 });
      expect(outcome.aggregated).toContain("RECEIVED=e4bda0e5a5bdf09f9880c3a900ff030d");
      expect(result.content).toContainEqual({
        type: "text",
        text: `Sent 16 bytes to session ${sessionId}.`,
      });
    } finally {
      if (!run.session.exited) {
        run.kill();
      }
      await run.promise;
    }
  },
);
