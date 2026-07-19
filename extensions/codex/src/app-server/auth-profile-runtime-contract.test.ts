// Codex tests cover auth profile runtime contract plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  abortAndDrainAgentHarnessRun,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness";
import { AUTH_PROFILE_RUNTIME_CONTRACT } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexRuntimePlanFixture } from "./run-attempt-test-harness.js";
import { runCodexAppServerAttempt as runCodexAppServerAttemptImpl } from "./run-attempt.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  adaptCodexTestClientFactory,
  createCodexTestModel,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";

let codexAppServerClientFactoryForTest: CodexTestAppServerClientFactory | undefined;

type RunCodexAppServerAttemptOptions = Omit<
  NonNullable<Parameters<typeof runCodexAppServerAttemptImpl>[1]>,
  "bindingStore"
>;

function setCodexAppServerClientFactoryForTest(factory: CodexTestAppServerClientFactory): void {
  codexAppServerClientFactoryForTest = factory;
}

function resetCodexAppServerClientFactoryForTest(): void {
  codexAppServerClientFactoryForTest = undefined;
}

function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: RunCodexAppServerAttemptOptions = {},
) {
  const clientFactory =
    options.clientFactory ??
    (codexAppServerClientFactoryForTest
      ? adaptCodexTestClientFactory(codexAppServerClientFactoryForTest)
      : undefined);
  return runCodexAppServerAttemptImpl(params, {
    ...options,
    bindingStore: testCodexAppServerBindingStore,
    ...(clientFactory ? { clientFactory } : {}),
  });
}

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  registerCodexTestSessionIdentity(
    sessionFile,
    AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
    AUTH_PROFILE_RUNTIME_CONTRACT.sessionKey,
  );
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
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function setPreparedOpenAIRoute(
  params: EmbeddedRunAttemptParams,
  authRequirement: "api-key" | "subscription",
  forwardedAuthProfileId?: string,
): void {
  const runtimePlan = createCodexRuntimePlanFixture();
  params.runtimePlan = {
    ...runtimePlan,
    auth: {
      ...runtimePlan.auth,
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: authRequirement,
      ...(forwardedAuthProfileId ? { forwardedAuthProfileId } : {}),
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.4-codex",
        api: authRequirement === "api-key" ? "openai-responses" : "openai-chatgpt-responses",
        baseUrl:
          authRequirement === "api-key"
            ? "https://api.openai.com/v1"
            : "https://chatgpt.com/backend-api/codex",
        authRequirement,
        requestTransportOverrides: "none",
      },
    },
  };
}

const DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT = JSON.stringify({
  "features.standalone_web_search": false,
  web_search: "disabled",
});
const APP_SERVER_START_WAIT = { interval: 1, timeout: 5_000 } as const;

function writeCodexAppServerBinding(...args: Parameters<typeof writeRawCodexAppServerBinding>) {
  const [sessionFile, binding, lookup] = args;
  return writeRawCodexAppServerBinding(
    sessionFile,
    {
      webSearchThreadConfigFingerprint: DISABLED_CODEX_WEB_SEARCH_THREAD_CONFIG_FINGERPRINT,
      ...binding,
    },
    lookup,
  );
}

function threadStartResult(threadId = "thread-auth-contract") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
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

function getMockServerVersion() {
  return "0.132.0";
}

function getMockRuntimeIdentity() {
  return { serverVersion: getMockServerVersion() };
}

function mockClientRuntimeMethods() {
  return {
    getInstanceId: () => "test-client-1",
    getRuntimeIdentity: getMockRuntimeIdentity,
    getServerVersion: getMockServerVersion,
  };
}

function createCodexAuthProfileHarness(params: { startMethod: "thread/start" | "thread/resume" }) {
  const seenAuthProfileIds: Array<string | undefined> = [];
  const seenAgentDirs: Array<string | undefined> = [];
  const seenClientOptions: Array<NonNullable<Parameters<CodexTestAppServerClientFactory>[4]>> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const notificationHandlers = new Set<(notification: unknown) => Promise<void> | void>();
  const notify = async (notification: unknown) => {
    await Promise.all(
      [...notificationHandlers].map((handler) => Promise.resolve(handler(notification))),
    );
  };
  setCodexAppServerClientFactoryForTest(
    async (_startOptions, authProfileId, agentDir, _config, options) => {
      seenAuthProfileIds.push(authProfileId);
      seenAgentDirs.push(agentDir);
      if (options) {
        seenClientOptions.push(options);
      }
      return {
        ...mockClientRuntimeMethods(),
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
        addNotificationHandler: (handler: (notification: unknown) => Promise<void> | void) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    },
  );
  return {
    seenAuthProfileIds,
    seenAgentDirs,
    seenClientOptions,
    async waitForMethod(method: string) {
      await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain(method), {
        ...APP_SERVER_START_WAIT,
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
    resetCodexTestBindingStore();
    vi.useRealTimers();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-auth-contract-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await abortAndDrainAgentHarnessRun({
      sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
      sessionKey: AUTH_PROFILE_RUNTIME_CONTRACT.sessionKey,
      settleMs: 1_000,
      forceClear: true,
      reason: "test_cleanup",
    });
    resetCodexAppServerClientFactoryForTest();
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
      APP_SERVER_START_WAIT,
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
      APP_SERVER_START_WAIT,
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
      authProfileId: "openai:stale",
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
      APP_SERVER_START_WAIT,
    );
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.authProfileId).toBe(AUTH_PROFILE_RUNTIME_CONTRACT.openAiCodexProfileId);
  });

  it("locks a prepared Platform route to its resolved API key", async () => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/start" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const params = createParams(sessionFile, tmpDir);
    params.agentDir = tmpDir;
    params.resolvedApiKey = "prepared-platform-key";
    params.authProfileStore = {
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60 * 60_000,
        },
      },
      order: { openai: ["openai:chatgpt"] },
    };
    setPreparedOpenAIRoute(params, "api-key");

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () => expect(harness.seenClientOptions).toHaveLength(1),
      APP_SERVER_START_WAIT,
    );
    expect(harness.seenClientOptions[0]).toMatchObject({
      preparedAuth: {
        kind: "api-key",
        apiKey: "prepared-platform-key",
      },
    });
    expect(harness.seenClientOptions[0]).not.toHaveProperty("authProfileId");
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.authProfileId).toBeUndefined();
  });

  it("locks a prepared subscription route to its forwarded OAuth profile", async () => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/start" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const params = createParams(sessionFile, tmpDir);
    const authProfileStore = {
      version: 1 as const,
      profiles: {
        "openai:chatgpt": {
          type: "oauth" as const,
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60 * 60_000,
        },
      },
    };
    params.authProfileStore = authProfileStore;
    setPreparedOpenAIRoute(params, "subscription", "openai:chatgpt");

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () => expect(harness.seenClientOptions).toHaveLength(1),
      APP_SERVER_START_WAIT,
    );
    expect(harness.seenClientOptions[0]).toMatchObject({
      preparedAuth: {
        kind: "profile",
        profileId: "openai:chatgpt",
        store: authProfileStore,
      },
    });
    expect(harness.seenClientOptions[0]).not.toHaveProperty("authProfileId");
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;
  });

  it("accepts a prepared subscription route with a real token profile", async () => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/start" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const params = createParams(sessionFile, tmpDir);
    const authProfileStore = {
      version: 1 as const,
      profiles: {
        "openai:token": {
          type: "token" as const,
          provider: "openai",
          token: "prepared-subscription-token",
        },
      },
    };
    params.authProfileStore = authProfileStore;
    setPreparedOpenAIRoute(params, "subscription", "openai:token");

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(
      () => expect(harness.seenClientOptions).toHaveLength(1),
      APP_SERVER_START_WAIT,
    );
    expect(harness.seenClientOptions[0]).toMatchObject({
      preparedAuth: {
        kind: "profile",
        profileId: "openai:token",
        store: authProfileStore,
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;
  });

  it("fails before profile selection when a prepared Platform route has no key", async () => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/start" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const params = createParams(sessionFile, tmpDir);
    params.authProfileStore = {
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:chatgpt"] },
    };
    setPreparedOpenAIRoute(params, "api-key");

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Prepared Codex API-key route is missing its resolved API key.",
    );
    expect(harness.seenClientOptions).toHaveLength(0);
  });

  it.each([
    { label: "no forwarded profile", forwardedProfileId: undefined, profileType: "oauth" as const },
    {
      label: "an API-key profile",
      forwardedProfileId: "openai:platform",
      profileType: "api_key" as const,
    },
  ])("rejects a subscription route with $label", async (testCase) => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/start" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const params = createParams(sessionFile, tmpDir);
    vi.stubEnv("OPENAI_API_KEY", "ambient-platform-key");
    vi.stubEnv("CODEX_ACCESS_TOKEN", "ambient-subscription-token");
    params.authProfileStore = {
      version: 1,
      profiles:
        testCase.profileType === "api_key"
          ? {
              "openai:platform": {
                type: "api_key",
                provider: "openai",
                key: "platform-profile-key",
              },
              "openai:decoy": {
                type: "oauth",
                provider: "openai",
                access: "decoy-subscription-token",
                refresh: "decoy-refresh-token",
                expires: Date.now() + 60_000,
              },
            }
          : {
              "openai:decoy": {
                type: "oauth",
                provider: "openai",
                access: "decoy-subscription-token",
                refresh: "decoy-refresh-token",
                expires: Date.now() + 60_000,
              },
            },
    };
    setPreparedOpenAIRoute(params, "subscription", testCase.forwardedProfileId);

    try {
      await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
        "Prepared Codex subscription route requires a forwarded OpenAI OAuth or token profile.",
      );
      expect(harness.seenClientOptions).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
