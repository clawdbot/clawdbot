import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { prependRedactionWarning, renderExecUpdateText } from "./bash-tools.exec-output.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";

const EXEC_REDACTION_WARNING = prependRedactionWarning("", true).trimEnd();
const supervisorMock = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({ spawn: supervisorMock.spawn }),
}));

beforeEach(() => {
  resetProcessRegistryForTests();
  supervisorMock.spawn.mockReset();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

describe("renderExecUpdateText", () => {
  it("uses a non-empty placeholder when an exec update has no output", () => {
    expect(renderExecUpdateText({ tailText: "", warnings: [] })).toBe("(no output)");
  });

  it("preserves non-empty exec output", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: [] })).toBe("hello");
  });

  it("keeps warnings while still avoiding empty output text", () => {
    expect(renderExecUpdateText({ tailText: "", warnings: ["Warning: retrying"] })).toBe(
      "Warning: retrying\n\n(no output)",
    );
  });

  it("combines warnings with non-empty output", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: ["Warning: retrying"] })).toBe(
      "Warning: retrying\n\nhello",
    );
  });

  it("adds a visible warning when output was redacted", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: [], redacted: true })).toBe(
      `${EXEC_REDACTION_WARNING}\n\nhello`,
    );
  });
});

describe("runExecProcess live updates", () => {
  it("redacts secret-shaped stdout in update text and details tail", async () => {
    const fakeSecretOutput = "OPENAI_API_KEY=sk-proj-redaction-canary-1234567890";
    const updates: Array<{ content: Array<{ type: string; text?: string }>; details: unknown }> =
      [];
    supervisorMock.spawn.mockImplementationOnce(
      async (input: { onStdout?: (chunk: string) => void }) => ({
        runId: "run-redact-live-update",
        startedAtMs: Date.now(),
        pid: 123,
        stdin: undefined,
        wait: async () => {
          input.onStdout?.(`${fakeSecretOutput}\n`);
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
          return {
            reason: "exit" as const,
            exitCode: 0,
            exitSignal: null,
            durationMs: 10,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          };
        },
        cancel: vi.fn(),
      }),
    );
    const run = await runExecProcess({
      command: "printf secret",
      workdir: "/tmp",
      env: {},
      usePty: false,
      warnings: [],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      notifyOnExitEmptySuccess: false,
      timeoutSec: null,
      onUpdate: (update) => updates.push(update),
    });
    await run.promise;
    const update = expectDefined(updates[0], "updates[0] test invariant");
    const text = (update.content[0] as { text?: string }).text ?? "";
    const details = update.details as { tail?: string; redacted?: boolean };
    expect(text).not.toContain(fakeSecretOutput);
    expect(details.tail).not.toContain(fakeSecretOutput);
    expect(text).toContain("OPENAI_API_KEY=sk-pro…7890");
    expect(details.tail).toContain("OPENAI_API_KEY=***");
    expect(text).toContain(EXEC_REDACTION_WARNING);
    expect(details.redacted).toBe(true);
  });

  it("redacts secret-shaped warnings in update text", async () => {
    const fakeSecretOutput = "OPENAI_API_KEY=sk-proj-redaction-canary-1234567890";
    const updates: Array<{ content: Array<{ type: string; text?: string }>; details: unknown }> =
      [];
    supervisorMock.spawn.mockImplementationOnce(
      async (input: { onStdout?: (chunk: string) => void }) => ({
        runId: "run-redact-live-warning",
        startedAtMs: Date.now(),
        pid: 123,
        stdin: undefined,
        wait: async () => {
          input.onStdout?.("ready\n");
          await new Promise((resolve) => {
            setImmediate(resolve);
          });
          return {
            reason: "exit" as const,
            exitCode: 0,
            exitSignal: null,
            durationMs: 10,
            stdout: "",
            stderr: "",
            timedOut: false,
            noOutputTimedOut: false,
          };
        },
        cancel: vi.fn(),
      }),
    );
    const run = await runExecProcess({
      command: "printf ready",
      workdir: "/tmp",
      env: {},
      usePty: false,
      warnings: [`Warning: ${fakeSecretOutput}`],
      maxOutput: 1000,
      pendingMaxOutput: 1000,
      notifyOnExit: false,
      notifyOnExitEmptySuccess: false,
      timeoutSec: null,
      onUpdate: (update) => updates.push(update),
    });
    await run.promise;
    const update = expectDefined(updates[0], "updates[0] test invariant");
    const text = (update.content[0] as { text?: string }).text ?? "";
    expect(text).not.toContain(fakeSecretOutput);
    expect(text).toContain("OPENAI_API_KEY=sk-pro…7890");
    expect(text).toContain(EXEC_REDACTION_WARNING);
    expect((update.details as { redacted?: boolean }).redacted).toBe(true);
    expect(text).toContain("ready");
  });
});
