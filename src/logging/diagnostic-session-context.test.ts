// Diagnostic session context tests cover session context capture for diagnostics.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveCronStore } from "../cron/store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  formatCronSessionDiagnosticFields,
  formatStoppedCronSessionDiagnosticFields,
  parseCronRunSessionKey,
  readLastAssistantFromSessionFile,
  resolveCronSessionDiagnosticContext,
} from "./diagnostic-session-context.js";

let tempDir: string | undefined;
let testState: OpenClawTestState | undefined;

function writeJsonl(filePath: string, rows: unknown[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

describe("diagnostic session context", () => {
  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-diagnostic-session-",
    });
    tempDir = testState.stateDir;
  });

  afterEach(async () => {
    await testState?.cleanup();
    testState = undefined;
    tempDir = undefined;
  });

  it("parses cron run session keys", () => {
    expect(parseCronRunSessionKey("agent:clawblocker:cron:job-123:run:run-456")).toEqual({
      agentId: "clawblocker",
      cronJobId: "job-123",
      cronRunId: "run-456",
    });
  });

  it("formats cron job and last assistant context for stalled session logs", async () => {
    const stateDir = tempDir!;
    await saveCronStore(path.join(stateDir, "cron", "jobs.json"), {
      version: 1,
      jobs: [
        {
          id: "job-123",
          name: "Twitter Mention Moderation Agent",
          enabled: true,
          createdAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_000_000,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      ],
    });
    writeJsonl(path.join(stateDir, "agents", "clawblocker", "sessions", "run-456.jsonl"), [
      { message: { role: "user", content: "run" } },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "There are 40\ncached mentions ready." }],
        },
      },
    ]);

    const context = resolveCronSessionDiagnosticContext({
      sessionKey: "agent:clawblocker:cron:job-123:run:run-456",
    });

    expect(formatCronSessionDiagnosticFields(context)).toContain("cronJobId=job-123");
    expect(formatCronSessionDiagnosticFields(context)).toContain("cronRunId=run-456");
    expect(formatCronSessionDiagnosticFields(context)).toContain(
      'cronJob="Twitter Mention Moderation Agent"',
    );
    expect(formatCronSessionDiagnosticFields(context)).toContain(
      'lastAssistant="There are 40 cached mentions ready."',
    );
    expect(formatStoppedCronSessionDiagnosticFields(context)).toContain(
      'stopped="Twitter Mention Moderation Agent"',
    );
  });

  it("reads the latest assistant message from a transcript tail", () => {
    const filePath = path.join(tempDir!, "session.jsonl");
    writeJsonl(filePath, [
      { message: { role: "assistant", content: "older" } },
      { message: { role: "user", content: "later user" } },
      { message: { role: "assistant", content: "newer" } },
    ]);

    expect(readLastAssistantFromSessionFile(filePath)).toBe("newer");
  });

  it("ignores missing transcript tail files", () => {
    expect(readLastAssistantFromSessionFile(path.join(tempDir!, "missing.jsonl"))).toBeUndefined();
  });
});
