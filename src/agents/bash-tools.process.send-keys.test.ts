import { afterEach, expect, test } from "vitest";
import {
  addSession,
  markBackgrounded,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import { createProcessTool } from "./bash-tools.process.js";

function createWritableStdinStub() {
  return {
    write(_data: string, cb?: (err?: Error | null) => void) {
      cb?.();
    },
    end() {},
    destroyed: false,
  };
}

afterEach(() => {
  resetProcessRegistryForTests();
});

function currentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
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
  return { processTool, sessionId: run.session.id };
}

async function waitForSessionCompletion(params: {
  processTool: ReturnType<typeof createProcessTool>;
  sessionId: string;
  expectedText: string;
}) {
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
        expect(details.aggregated ?? "").toContain(params.expectedText);
        return true;
      },
      {
        timeout: process.platform === "win32" ? 12_000 : 8_000,
        interval: 30,
      },
    )
    .toBe(true);
}

test("process send-keys encodes Enter for pty sessions", async () => {
  const { processTool, sessionId } = await startPtySession(
    'node -e "const dataEvent=String.fromCharCode(100,97,116,97);process.stdin.on(dataEvent,d=>{process.stdout.write(d);if(d.includes(10)||d.includes(13))process.exit(0);});"',
  );

  await processTool.execute("toolcall", {
    action: "send-keys",
    sessionId,
    keys: ["h", "i", "Enter"],
  });

  await waitForSessionCompletion({ processTool, sessionId, expectedText: "hi" });
});

test("process submit sends Enter for pty sessions", async () => {
  const { processTool, sessionId } = await startPtySession(
    'node -e "const dataEvent=String.fromCharCode(100,97,116,97);const submitted=String.fromCharCode(115,117,98,109,105,116,116,101,100);process.stdin.on(dataEvent,d=>{if(d.includes(10)||d.includes(13)){process.stdout.write(submitted);process.exit(0);}});"',
  );

  await processTool.execute("toolcall", {
    action: "submit",
    sessionId,
  });

  await waitForSessionCompletion({ processTool, sessionId, expectedText: "submitted" });
});

test("process send-keys fails loud for unknown cursor mode when arrows depend on it", async () => {
  const session = createProcessSessionFixture({
    id: "sess-unknown-mode",
    command: "vim",
    backgrounded: true,
    cursorKeyMode: "unknown",
  });
  session.stdin = createWritableStdinStub();
  addSession(session);

  const processTool = createProcessTool();
  const result = await processTool.execute("toolcall", {
    action: "send-keys",
    sessionId: "sess-unknown-mode",
    keys: ["up"],
  });

  expect(result.details).toMatchObject({ status: "failed" });
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("cursor key mode is not known yet"),
  });
});

test("process send-keys still sends non-cursor keys while mode is unknown", async () => {
  const session = createProcessSessionFixture({
    id: "sess-unknown-enter",
    command: "vim",
    backgrounded: true,
    cursorKeyMode: "unknown",
  });
  session.stdin = createWritableStdinStub();
  addSession(session);

  const processTool = createProcessTool();
  const result = await processTool.execute("toolcall", {
    action: "send-keys",
    sessionId: "sess-unknown-enter",
    keys: ["Enter"],
  });

  expect(result.details).toMatchObject({ status: "running" });
});
