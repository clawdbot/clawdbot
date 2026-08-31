import type { CopilotClient } from "@github/copilot-sdk";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAttemptTranscriptJournalFixtures,
  createFakeSession,
  createFixture,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";
import type { AttemptResultWithSdkSessionId } from "./attempt-types.js";
import { runCopilotAttempt } from "./attempt.js";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import type { CopilotClientPool } from "./runtime.js";

afterEach(cleanupAttemptTranscriptJournalFixtures);

describe("Copilot canonical session identity", () => {
  it("keeps the host session through provider failure, retry, resume, and finalization", async () => {
    const { attempt, target, tempDir, bridge } = await createFixture();
    bridge.detach();
    const failure = new Error("Authentication failed with provider (HTTP 401)");
    let turns = 0;
    let sessions = 0;
    const newSession = (sessionId: string) => {
      const session = { ...createFakeSession(), sessionId };
      session.sendAndWait = vi.fn(async () => {
        turns += 1;
        session.emit(event("user.message", `user-${turns}`, { content: attempt.prompt }));
        if (turns === 1) {
          throw failure;
        }
        const assistant = event("assistant.message", `assistant-${turns}`, {
          content: `answer-${turns}`,
          messageId: `assistant-${turns}`,
        });
        session.emit(assistant);
        session.emit(event("session.idle", `idle-${turns}`, {}));
        return assistant as Awaited<ReturnType<typeof session.sendAndWait>>;
      });
      return session;
    };
    const client = {
      createSession: vi.fn(async () => newSession(`sdk-session-${++sessions}`)),
      resumeSession: vi.fn(async (id: string) => newSession(id)),
      deleteSession: vi.fn(async () => undefined),
    };
    const pool = {
      acquire: vi.fn(async (key) => ({ client: client as unknown as CopilotClient, key })),
      release: vi.fn(async () => undefined),
      dispose: vi.fn(async () => []),
      size: () => 0,
    } satisfies CopilotClientPool;
    const params = {
      ...attempt,
      agentDir: tempDir,
      model: {
        api: "openai-responses",
        id: "gpt-5.6-luna",
        name: "Luna",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 4096,
      } satisfies AgentHarnessAttemptParamsV2["model"],
      auth: { useLoggedInUser: true },
      hostCapabilities: createCopilotTestHostCapabilities(),
      promptMode: "none" as const,
      disableTools: true,
    };
    const deps = {
      pool,
      createToolBridge: async () => ({
        sourceTools: [],
        promptToolPolicy: { apply: () => ({ tools: [], callableToolNames: [] }) },
      }),
    };
    const failed = (await runCopilotAttempt(params, deps)) as AttemptResultWithSdkSessionId;
    expect(failed.terminal).toEqual({ kind: "failed", source: "prompt", error: failure });
    expect(failed.sdkSessionId).toBe("sdk-session-1");

    // The host adopts sessionIdUsed before retrying; storage must still accept
    // that exact identity, while the SDK independently resumes its native id.
    const retryParams = {
      ...params,
      sessionId: failed.sessionIdUsed,
      sessionTarget: { ...target, sessionId: failed.sessionIdUsed },
    };
    const retried = (await runCopilotAttempt(retryParams, deps)) as AttemptResultWithSdkSessionId;
    expect(retried.terminal).toEqual({ kind: "ok" });
    expect(retried.sessionIdUsed).toBe(target.sessionId);
    expect(retried.replayMetadata.replaySafe).toBe(true);

    const resumeParams = {
      ...retryParams,
      sessionId: retried.sessionIdUsed,
      initialReplayState: {
        replayInvalid: !retried.replayMetadata.replaySafe,
        hadPotentialSideEffects: retried.replayMetadata.hadPotentialSideEffects,
        journalValidated: retried.journalValidated,
        sdkSessionId: retried.sdkSessionId,
      },
    };
    const resumed = (await runCopilotAttempt(resumeParams, deps)) as AttemptResultWithSdkSessionId;
    expect(resumed.terminal).toEqual({ kind: "ok" });
    expect(resumed.sessionIdUsed).toBe(target.sessionId);
    expect(resumed.replayMetadata.replaySafe).toBe(true);

    const final = (await runCopilotAttempt(
      { ...resumeParams, sessionId: resumed.sessionIdUsed },
      { ...deps, operation: "settled-tool-finalization" },
    )) as AttemptResultWithSdkSessionId;
    expect(final.terminal).toEqual({ kind: "ok" });
    expect(final.sessionIdUsed).toBe(target.sessionId);
    expect(final.sdkSessionId).toBe("sdk-session-2");
    expect(client.createSession).toHaveBeenCalledTimes(2);
    expect(client.resumeSession.mock.calls.map(([id]) => id)).toEqual([
      "sdk-session-2",
      "sdk-session-2",
    ]);
    expect(
      transcriptMessages(await readSessionTranscriptEvents(target)).map((row) => row.message.role),
    ).toEqual(["user", "assistant", "assistant", "assistant"]);
  });
});
