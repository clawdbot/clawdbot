// Codex tests cover conversation control plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import {
  getSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexSupervisionTestConnectionFingerprint,
  readCodexAppServerBinding,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.test-helpers.js";
import {
  steerCodexConversationTurn,
  stopCodexConversationTurn,
  trackCodexConversationActiveTurn,
  setCodexConversationFastMode as setCodexConversationFastModeImpl,
  setCodexConversationModel as setCodexConversationModelImpl,
  setCodexConversationPermissions as setCodexConversationPermissionsImpl,
} from "./conversation-control.js";

function controlTarget(sessionFile: string) {
  return {
    identity: { kind: "session" as const, agentId: "main", sessionId: sessionFile },
    bindingStore: testCodexAppServerBindingStore,
  };
}

function setCodexConversationFastMode(
  params: Omit<
    Parameters<typeof setCodexConversationFastModeImpl>[0],
    "identity" | "bindingStore"
  > & {
    sessionFile: string;
  },
) {
  const { sessionFile, ...rest } = params;
  return setCodexConversationFastModeImpl({ ...rest, ...controlTarget(sessionFile) });
}

function setCodexConversationModel(
  params: Omit<Parameters<typeof setCodexConversationModelImpl>[0], "identity" | "bindingStore"> & {
    sessionFile: string;
  },
) {
  const { sessionFile, ...rest } = params;
  return setCodexConversationModelImpl({ ...rest, ...controlTarget(sessionFile) });
}

let tempDir: string;

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: sharedClientMocks.getSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  withLeasedCodexAppServerClientStartSelectionRetry: async (params: {
    lease: { client?: unknown };
    run: (client: unknown) => Promise<unknown>;
  }) => await params.run(params.lease.client),
}));

describe("codex conversation controls", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-control-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    clearRuntimeAuthProfileStoreSnapshots();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists fast mode on the binding and permissions on the session", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const session = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
    };
    const storePath = resolveStorePath(undefined, { agentId: session.agentId });
    await upsertSessionEntry({
      agentId: session.agentId,
      sessionKey: session.sessionKey,
      storePath,
      entry: { sessionId: session.sessionId, updatedAt: Date.now(), permissionMode: "full" },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    await expect(setCodexConversationFastMode({ sessionFile, enabled: true })).resolves.toBe(
      "Codex fast mode enabled.",
    );
    await expect(
      setCodexConversationPermissionsImpl({ session, mode: "default", config: {} }),
    ).resolves.toBe("Codex permissions set to default.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.serviceTier).toBe("priority");
    expect(binding?.approvalPolicy).toBe("never");
    expect(binding?.sandbox).toBe("danger-full-access");
    expect(
      getSessionEntry({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        storePath,
        readConsistency: "latest",
      })?.permissionMode,
    ).toBeUndefined();

    await expect(
      setCodexConversationPermissionsImpl({ session, mode: "yolo", config: {} }),
    ).resolves.toBe("Codex permissions set to full access.");
    expect(
      getSessionEntry({
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        storePath,
        readConsistency: "latest",
      })?.permissionMode,
    ).toBe("full");
  });

  it("routes supervised stop and steer requests through the native user-home connection", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const target = controlTarget(sessionFile);
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-supervised",
      appServerRuntimeFingerprint: buildCodexSupervisionTestConnectionFingerprint(),
      cwd: tempDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });
    const request = vi.fn(async () => ({}));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });
    const stopTracking = trackCodexConversationActiveTurn({
      identity: target.identity,
      threadId: "thread-supervised",
      turnId: "turn-1",
    });

    try {
      await stopCodexConversationTurn({
        ...target,
        pluginConfig: { supervision: { enabled: true } },
      });
      await steerCodexConversationTurn({
        ...target,
        message: "focus tests",
        pluginConfig: { supervision: { enabled: true } },
      });
    } finally {
      stopTracking();
    }

    for (const [options] of sharedClientMocks.getSharedCodexAppServerClient.mock.calls) {
      expect(options).toMatchObject({
        authProfileId: null,
        startOptions: { homeScope: "user" },
      });
    }
    expect(request).toHaveBeenNthCalledWith(
      1,
      "turn/interrupt",
      { threadId: "thread-supervised", turnId: "turn-1" },
      { timeoutMs: 60_000 },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "turn/steer",
      {
        threadId: "thread-supervised",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "focus tests", text_elements: [] }],
      },
      { timeoutMs: 60_000 },
    );
  });

  it("refuses to stop or steer when the active turn no longer matches the private binding", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const target = controlTarget(sessionFile);
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "replacement-thread",
      cwd: tempDir,
    });
    const stopTracking = trackCodexConversationActiveTurn({
      identity: target.identity,
      threadId: "stale-active-thread",
      turnId: "turn-1",
    });

    try {
      await expect(stopCodexConversationTurn(target)).resolves.toEqual({
        stopped: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await expect(
        steerCodexConversationTurn({ ...target, message: "do not send" }),
      ).resolves.toEqual({
        steered: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await testCodexAppServerBindingStore.mutate(target.identity, { kind: "clear" });
      await expect(stopCodexConversationTurn(target)).resolves.toEqual({
        stopped: false,
        message: "The active Codex run no longer matches this session binding.",
      });
      await expect(
        steerCodexConversationTurn({ ...target, message: "still do not send" }),
      ).resolves.toEqual({
        steered: false,
        message: "The active Codex run no longer matches this session binding.",
      });
    } finally {
      stopTracking();
    }

    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("rejects direct model changes for private supervised bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-supervised",
      connectionScope: "supervision",
      supervisionSourceThreadId: "thread-supervised",
      cwd: tempDir,
      model: "gpt-5.5",
      modelProvider: "openai",
      preserveNativeModel: true,
      conversationSourceTransferComplete: true,
    });

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "gpt-5.4",
        pluginConfig: { supervision: { enabled: true } },
      }),
    ).rejects.toThrow(MODEL_SELECTION_LOCKED_MESSAGE);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("does not persist public OpenAI provider after model changes on native auth bindings", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
    upsertAuthProfile({
      profileId: "work",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    });
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "work",
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    await expect(
      setCodexConversationModel({ sessionFile, agentDir, model: "gpt-5.5" }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.authProfileId).toBe("work");
    expect(binding?.model).toBe("gpt-5.5");
    expect(binding?.modelProvider).toBeUndefined();
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("persists provider-qualified model changes without resuming a subscribed thread", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-5.5",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.model).toBe("gpt-5.5");
    expect(binding?.modelProvider).toBe("openai");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("keeps the bound local provider when switching to another unqualified model", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "local-model-2",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to local-model-2.");

    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      model: "local-model-2",
      modelProvider: "lmstudio",
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("keeps the bound local provider when reselecting a model id with a slash", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-oss-20b",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to openai/gpt-oss-20b.");

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.model).toBe("openai/gpt-oss-20b");
    expect(binding?.modelProvider).toBe("lmstudio");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("persists ordinary model selection on SessionEntry without overwriting native ownership", async () => {
    const sessionKey = "agent:main:model-session";
    const sessionId = "session-model-authority";
    const identity = { kind: "session" as const, agentId: "main", sessionId, sessionKey };
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey,
      entry: {
        sessionId,
        updatedAt: Date.now(),
        authProfileOverride: "openai:personal",
        authProfileOverrideSource: "user",
      },
    });
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-model-authority",
        cwd: tempDir,
        model: "gpt-5.4",
        modelProvider: "openai",
      },
    });

    await expect(
      setCodexConversationModelImpl({
        identity,
        bindingStore: testCodexAppServerBindingStore,
        model: "gpt-5.5",
      }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      authProfileOverride: "openai:personal",
      authProfileOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: "thread-model-authority",
      model: "gpt-5.4",
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("drops an incompatible pinned auth profile when selecting another provider", async () => {
    const sessionKey = "agent:main:model-provider-switch";
    const sessionId = "session-provider-switch";
    const identity = { kind: "session" as const, agentId: "main", sessionId, sessionKey };
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey,
      entry: {
        sessionId,
        updatedAt: Date.now(),
        authProfileOverride: "lmstudio:work",
        authProfileOverrideSource: "user",
      },
    });
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "thread-provider-switch",
        cwd: tempDir,
        model: "local-model",
        modelProvider: "lmstudio",
      },
    });

    await expect(
      setCodexConversationModelImpl({
        identity,
        bindingStore: testCodexAppServerBindingStore,
        model: "openai/gpt-5.5",
      }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      liveModelSwitchPending: true,
    });
    expect(getSessionEntry({ storePath, sessionKey })?.authProfileOverride).toBeUndefined();
  });

  it("escapes requested model names before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "gpt-5.5 <@U123> [trusted](evil)",
      }),
    ).resolves.toBe(
      "Codex model set to gpt-5.5 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08evil\uff09.",
    );
  });
});
