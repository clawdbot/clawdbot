// Diagnostic session context tests cover session context capture for diagnostics.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptMessageSync,
  readLatestTranscriptAssistantText,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { saveCronStore } from "../cron/store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  formatCronSessionDiagnosticFields,
  formatStoppedCronSessionDiagnosticFields,
  resolveCronSessionDiagnosticContext,
} from "./diagnostic-session-context.js";

let tempDir: string | undefined;
let testState: OpenClawTestState | undefined;

async function seedSessionTranscript(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  messages: unknown[];
  incognito?: boolean;
}) {
  const { agentId, sessionId, sessionKey, messages, incognito } = params;
  await replaceSessionEntry(
    { agentId, sessionKey },
    { sessionId, updatedAt: 1, ...(incognito ? { incognito: true } : {}) },
  );
  for (const message of messages) {
    appendTranscriptMessageSync({ agentId, sessionId, sessionKey }, { message });
  }
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
    expect(
      resolveCronSessionDiagnosticContext({
        sessionKey: "agent:clawblocker:cron:job-123:run:run-456",
      }),
    ).toMatchObject({ agentId: "clawblocker", cronJobId: "job-123", cronRunId: "run-456" });
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
    const sessionKey = "agent:clawblocker:cron:job-123:run:run-456";
    await seedSessionTranscript({
      agentId: "clawblocker",
      sessionId: "run-456",
      sessionKey,
      messages: [
        { role: "user", content: "run" },
        {
          role: "assistant",
          content: [{ type: "text", text: "There are 40\ncached mentions ready." }],
        },
      ],
    });

    const context = resolveCronSessionDiagnosticContext({
      sessionKey,
      activeSessionId: "run-456",
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

  it("reads the latest visible app-agent assistant text from its SQLite transcript", async () => {
    const sessionKey = "agent:oauth-agent:main";
    await seedSessionTranscript({
      agentId: "oauth-agent",
      sessionId: "oauth-session",
      sessionKey,
      messages: [
        { role: "assistant", content: "older reply" },
        { role: "user", content: "later user" },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "internal reasoning",
              textSignature: JSON.stringify({ v: 1, id: "reasoning", phase: "commentary" }),
            },
            {
              type: "text",
              text: "latest visible reply",
              textSignature: JSON.stringify({ v: 1, id: "reply", phase: "final_answer" }),
            },
          ],
        },
      ],
    });

    const context = resolveCronSessionDiagnosticContext({
      sessionKey,
      activeSessionId: "oauth-session",
    });

    expect(context.lastAssistant).toBe("latest visible reply");
    expect(formatCronSessionDiagnosticFields(context)).toBe('lastAssistant="latest visible reply"');
  });

  it.each(["dashboard", "subagent", "internal-session-effects"])(
    "never exposes a %s incognito assistant reply to durable diagnostics",
    async (sessionSurface) => {
      const sessionKey = `agent:main:${sessionSurface}:incognito-private`;
      const sessionId = `incognito-${sessionSurface}`;
      const privateReply = `memory-only ${sessionSurface} reply`;
      await seedSessionTranscript({
        agentId: "main",
        incognito: true,
        sessionId,
        sessionKey,
        messages: [{ role: "assistant", content: privateReply }],
      });

      expect(
        readLatestTranscriptAssistantText({ agentId: "main", sessionId, sessionKey })?.text,
      ).toBe(privateReply);
      expect(
        resolveCronSessionDiagnosticContext({ sessionKey, activeSessionId: sessionId }),
      ).toEqual({});
      expect(
        fs.existsSync(path.join(tempDir!, "agents", "main", "agent", "openclaw-agent.sqlite")),
      ).toBe(false);
    },
  );

  it("requires the authoritative current session id before reading transcript text", async () => {
    const sessionKey = "agent:oauth-agent:main";
    await seedSessionTranscript({
      agentId: "oauth-agent",
      sessionId: "current-session",
      sessionKey,
      messages: [{ role: "assistant", content: "current private reply" }],
    });

    expect(
      resolveCronSessionDiagnosticContext({
        sessionKey,
        activeSessionId: "rotated-session",
      }).lastAssistant,
    ).toBeUndefined();
    expect(resolveCronSessionDiagnosticContext({ sessionKey }).lastAssistant).toBeUndefined();
  });

  it("keeps identical session ids isolated to their owning agents", async () => {
    await seedSessionTranscript({
      agentId: "main",
      sessionId: "shared-session-id",
      sessionKey: "agent:main:main",
      messages: [{ role: "assistant", content: "main private reply" }],
    });
    await seedSessionTranscript({
      agentId: "oauth-agent",
      sessionId: "shared-session-id",
      sessionKey: "agent:oauth-agent:main",
      messages: [{ role: "assistant", content: "oauth private reply" }],
    });

    expect(
      resolveCronSessionDiagnosticContext({
        sessionKey: "agent:oauth-agent:main",
        activeSessionId: "shared-session-id",
      }).lastAssistant,
    ).toBe("oauth private reply");
  });

  it("rejects malformed agent ids before resolving a default agent transcript", async () => {
    await seedSessionTranscript({
      agentId: "main",
      sessionId: "main-session",
      sessionKey: "agent:main:main",
      messages: [{ role: "assistant", content: "main private reply" }],
    });

    expect(
      resolveCronSessionDiagnosticContext({
        sessionKey: "agent:../main:main",
        activeSessionId: "main-session",
      }),
    ).toEqual({});
  });

  it("does not treat channel-owned cron segments as cron metadata", async () => {
    const sessionKey = "agent:oauth-agent:slack:cron:job-123:run:run-456";
    await seedSessionTranscript({
      agentId: "oauth-agent",
      sessionId: "slack-session",
      sessionKey,
      messages: [{ role: "assistant", content: "channel reply" }],
    });

    const context = resolveCronSessionDiagnosticContext({
      sessionKey,
      activeSessionId: "slack-session",
    });

    expect(context.lastAssistant).toBe("channel reply");
    expect(context.cronJobId).toBeUndefined();
    expect(context.cronRunId).toBeUndefined();
  });

  it("keeps bounded quoted fields UTF-16 safe", () => {
    const prefix = "a".repeat(136);

    expect(
      formatCronSessionDiagnosticFields({ cronJobName: `${prefix}😀${"b".repeat(140)}` }),
    ).toBe(`cronJob="${prefix}..."`);
  });

  it("does not create an agent database when its session store is missing", () => {
    const databasePath = path.join(
      tempDir!,
      "agents",
      "missing-agent",
      "agent",
      "openclaw-agent.sqlite",
    );
    expect(fs.existsSync(databasePath)).toBe(false);

    expect(
      resolveCronSessionDiagnosticContext({
        sessionKey: "agent:missing-agent:main",
        activeSessionId: "missing",
      }).lastAssistant,
    ).toBeUndefined();
    expect(fs.existsSync(databasePath)).toBe(false);
  });
});
