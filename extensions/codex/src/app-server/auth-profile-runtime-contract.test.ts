import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  abortAgentHarnessRun,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness";
import { AUTH_PROFILE_RUNTIME_CONTRACT } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCodexAppServerAttempt, __testing } from "./run-attempt.js";
import { readCodexAppServerBinding, writeCodexAppServerBinding } from "./session-binding.js";
import { createCodexTestModel } from "./test-support.js";

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    prompt: AUTH_PROFILE_RUNTIME_CONTRACT.workspacePrompt,
    sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
    sessionKey: AUTH_PROFILE_RUNTIME_CONTRACT.sessionKey,
    sessionFile,
    workspaceDir,
    runId: AUTH_PROFILE_RUNTIME_CONTRACT.runId,
    provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider,
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel(AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function threadStartResult(threadId = "thread-auth-contract") {
  return {
    thread: {
      id: threadId,
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(turnId = "turn-auth-contract") {
  return {
    turn: {
      id: turnId,
      status: "inProgress",
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function createCodexAuthProfileHarness(params: { startMethod: "thread/start" | "thread/resume" }) {
  const seenAuthProfileIds: Array<string | undefined> = [];
  const seenAgentDirs: Array<string | undefined> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let notify: (notification: unknown) => Promise<void> = async () => undefined;
  __testing.setCodexAppServerClientFactoryForTests(
    async (_startOptions, authProfileId, agentDir) => {
      seenAuthProfileIds.push(authProfileId);
      seenAgentDirs.push(agentDir);
      return {
        request: vi.fn(async (method: string, requestParams?: unknown) => {
          requests.push({ method, params: requestParams });
          if (method === params.startMethod) {
            return threadStartResult();
          }
          if (method === "turn/start") {
            return turnStartResult();
          }
          throw new Error(`unexpected method: ${method}`);
        }),
        addNotificationHandler: (handler: (notification: unknown) => Promise<void>) => {
          notify = handler;
          return () => undefined;
        },
        addRequestHandler: () => () => undefined,
      } as never;
    },
  );
  return {
    seenAuthProfileIds,
    seenAgentDirs,
    async waitForMethod(method: string) {
      await vi.waitFor(() => expect(requests.some((entry) => entry.method === method)).toBe(true), {
        interval: 1,
      });
    },
    async completeTurn() {
      await notify({
        method: "turn/completed",
        params: {
          threadId: "thread-auth-contract",
          turnId: "turn-auth-contract",
          turn: { id: "turn-auth-contract", status: "completed" },
        },
      });
    },
  };
}

describe("Auth profile runtime contract - Codex app-server adapter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-auth-contract-"));
  });

  afterEach(async () => {
    abortAgentHarnessRun(AUTH_PROFILE_RUNTIME_CONTRACT.sessionId);
    __testing.resetCodexAppServerClientFactoryForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes the exact OpenAI Codex auth profile into app-server startup", async () => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/start" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const params = createParams(sessionFile, tmpDir);
    params.authProfileId = AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId;
    params.agentDir = tmpDir;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () =>
        expect(harness.seenAuthProfileIds).toEqual([
          AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
        ]),
      { interval: 1 },
    );
    expect(harness.seenAgentDirs).toEqual([tmpDir]);
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;
  });

  it("reuses a bound OpenAI Codex auth profile when resume params omit authProfileId", async () => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/resume" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-auth-contract",
      cwd: tmpDir,
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
      dynamicToolsFingerprint: "[]",
    });
    // authProfileId is intentionally omitted to exercise the resume-bound profile path.
    const params = createParams(sessionFile, tmpDir);

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () =>
        expect(harness.seenAuthProfileIds).toEqual([
          AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
        ]),
      { interval: 1 },
    );
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;
  });

  it("prefers an explicit runtime auth profile over a stale persisted binding", async () => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/resume" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-auth-contract",
      cwd: tmpDir,
      authProfileId: "openai-codex:stale",
      dynamicToolsFingerprint: "[]",
    });
    const params = createParams(sessionFile, tmpDir);
    params.authProfileId = AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId;

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () =>
        expect(harness.seenAuthProfileIds).toEqual([
          AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
        ]),
      { interval: 1 },
    );
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      authProfileId: AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId,
    });
  });
});
