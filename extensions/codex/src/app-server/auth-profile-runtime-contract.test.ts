// Codex tests cover auth profile runtime contract plugin behavior.
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { AUTH_PROFILE_RUNTIME_CONTRACT } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppServerHarness,
  createCodexRuntimePlanFixture,
  createParams as createSharedParams,
  runCodexAppServerAttempt as runSharedCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { CodexAppServerClientOptions } from "./shared-client.js";

/** Keeps native Codex bindings reusable while omitting OpenClaw tools and search. */
function withPersistentCodexTestToolPolicy(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams {
  const modelCompat =
    params.model.compat && typeof params.model.compat === "object" ? params.model.compat : {};
  const model = {
    ...params.model,
    compat: { ...modelCompat, supportsTools: false },
  } as EmbeddedRunAttemptParams["model"] & { compat: { supportsTools: boolean } };
  return {
    ...params,
    disableTools: false,
    model,
    config: {
      ...params.config,
      tools: {
        ...params.config?.tools,
        web: {
          ...params.config?.tools?.web,
          search: {
            ...params.config?.tools?.web?.search,
            enabled: false,
          },
        },
      },
    },
  };
}

function runCodexAppServerAttempt(
  params: EmbeddedRunAttemptParams,
  options: Parameters<typeof runSharedCodexAppServerAttempt>[1] = {},
) {
  return runSharedCodexAppServerAttempt(withPersistentCodexTestToolPolicy(params), options);
}

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  const params = createSharedParams(sessionFile, workspaceDir, {
    prompt: AUTH_PROFILE_RUNTIME_CONTRACT.workspacePrompt,
    sessionId: AUTH_PROFILE_RUNTIME_CONTRACT.sessionId,
    sessionKey: AUTH_PROFILE_RUNTIME_CONTRACT.sessionKey,
    runId: AUTH_PROFILE_RUNTIME_CONTRACT.runId,
    provider: AUTH_PROFILE_RUNTIME_CONTRACT.codexHarnessProvider,
  });
  delete params.contextTokenBudget;
  delete params.contextWindowInfo;
  delete params.observeToolTerminal;
  return params;
}

function createChatgptAccessToken(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `e30.${payload}.test-signature`;
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

function createCodexAuthProfileHarness(params: { startMethod: "thread/start" | "thread/resume" }) {
  const seenAuthProfileIds: Array<string | undefined> = [];
  const seenAgentDirs: Array<string | undefined> = [];
  const seenClientOptions: CodexAppServerClientOptions[] = [];
  const harness = createAppServerHarness(
    async (method) => {
      if (method === params.startMethod) {
        return threadStartResult("thread-auth-contract", { cwd: "" });
      }
      if (method === "turn/start") {
        return turnStartResult("turn-auth-contract");
      }
      throw new Error(`unexpected method: ${method}`);
    },
    {
      onStart(authProfileId, agentDir, options) {
        seenAuthProfileIds.push(authProfileId);
        seenAgentDirs.push(agentDir);
        if (options) {
          seenClientOptions.push(options);
        }
      },
    },
  );
  return {
    ...harness,
    seenAuthProfileIds,
    seenAgentDirs,
    seenClientOptions,
    async completeTurn() {
      await harness.notify({
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

setupRunAttemptTestHooks();

describe("Auth profile runtime contract - Codex app-server adapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tempDir;
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
          access: createChatgptAccessToken("account-oauth"),
          refresh: "refresh-token",
          expires: Date.now() + 60 * 60_000,
          accountId: "account-oauth",
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
        snapshot: {
          loginParams: {
            type: "chatgptAuthTokens",
            chatgptAccountId: "account-oauth",
          },
        },
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
          token: createChatgptAccessToken("account-token"),
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
        snapshot: {
          loginParams: {
            type: "chatgptAuthTokens",
            chatgptAccountId: "account-token",
          },
        },
      },
    });
    await harness.waitForMethod("turn/start");
    await harness.completeTurn();
    await run;
  });

  it.each([
    { label: "a subscription route", authRequirement: "subscription" as const },
    { label: "a Platform route", authRequirement: "api-key" as const },
  ])(
    "keeps a user-home app-server on native Codex auth for $label",
    async ({ authRequirement }) => {
      const harness = createCodexAuthProfileHarness({ startMethod: "thread/start" });
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const params = createParams(sessionFile, tmpDir);
      params.agentDir = tmpDir;
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
      setPreparedOpenAIRoute(params, authRequirement, "openai:chatgpt");

      const run = runCodexAppServerAttempt(params, {
        pluginConfig: {
          appServer: { homeScope: "user" },
          supervision: { enabled: true },
        },
      });
      await vi.waitFor(
        () => expect(harness.seenClientOptions).toHaveLength(1),
        APP_SERVER_START_WAIT,
      );
      expect(harness.seenClientOptions[0]).not.toHaveProperty("preparedAuth");
      expect(harness.seenClientOptions[0]).toMatchObject({
        startOptions: expect.objectContaining({ homeScope: "user" }),
      });
      await harness.waitForMethod("turn/start");
      await harness.completeTurn();
      await run;
    },
  );

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

  it("rejects ambient auth before a remote-exec attempt starts", async () => {
    const harness = createCodexAuthProfileHarness({ startMethod: "thread/start" });
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const params = createParams(sessionFile, tmpDir);
    vi.stubEnv("CODEX_API_KEY", "ambient-codex-key");
    vi.stubEnv("OPENAI_API_KEY", "ambient-openai-key");
    params.authProfileStore = { version: 1, profiles: {} };
    params.sandbox = {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec",
    } as NonNullable<typeof params.sandbox> & { placementExecutionMode: "remote-exec" };

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow(
      "Codex remote-exec cloud placement requires prepared OpenAI auth",
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
