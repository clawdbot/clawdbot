// Codex tests cover conversation control plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRuntimeAuthProfileStoreSnapshots } from "openclaw/plugin-sdk/agent-runtime";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
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

function setCodexConversationPermissions(
  params: Omit<
    Parameters<typeof setCodexConversationPermissionsImpl>[0],
    "identity" | "bindingStore"
  > & { sessionFile: string },
) {
  const { sessionFile, ...rest } = params;
  return setCodexConversationPermissionsImpl({ ...rest, ...controlTarget(sessionFile) });
}

let tempDir: string;

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
}));

function controlClient(request: ReturnType<typeof vi.fn>, clientId = "control-client") {
  return { request, getInstanceId: () => clientId };
}

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

  it("persists fast mode and permissions for later bound turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
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
    await expect(setCodexConversationPermissions({ sessionFile, mode: "default" })).resolves.toBe(
      "Codex permissions set to default.",
    );

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.serviceTier).toBe("priority");
    expect(binding?.approvalPolicy).toBe("on-request");
    expect(binding?.sandbox).toBe("workspace-write");
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
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(
      controlClient(
        vi.fn(async () => ({
          thread: { id: "thread-1", cwd: tempDir },
          model: "gpt-5.5",
          modelProvider: "openai",
        })),
      ),
    );

    await expect(
      setCodexConversationModel({ sessionFile, agentDir, model: "gpt-5.5" }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    const binding = await readCodexAppServerBinding(sessionFile);
    const sharedClientParams = sharedClientMocks.getSharedCodexAppServerClient.mock.calls[0]?.[0];
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(binding?.threadId).toBe("thread-1");
    expect(binding?.authProfileId).toBe("work");
    expect(binding?.model).toBe("gpt-5.5");
    expect(binding?.modelProvider).toBeUndefined();
    expect(binding?.clientId).toBe("control-client");
  });

  it("keeps Guardian reviewer when switching a stale local binding to a provider-qualified OpenAI model", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const request = vi.fn(async (_method: string, _requestParams?: unknown) => ({
      thread: { id: "thread-1", cwd: tempDir },
      model: "gpt-5.5",
      modelProvider: "openai",
    }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(controlClient(request));

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-5.5",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to gpt-5.5.");

    const resumeParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(resumeParams?.model).toBe("gpt-5.5");
    expect(resumeParams?.modelProvider).toBe("openai");
    expect(resumeParams?.approvalsReviewer).toBe("auto_review");
    expect(binding?.modelProvider).toBe("openai");
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
    const request = vi.fn(async (_method: string, _requestParams?: unknown) => ({
      thread: { id: "thread-1", cwd: tempDir },
      model: "local-model-2",
      modelProvider: "lmstudio",
    }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(controlClient(request));

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "local-model-2",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to local-model-2.");

    const resumeParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(resumeParams?.model).toBe("local-model-2");
    expect(resumeParams?.modelProvider).toBe("lmstudio");
    expect(resumeParams?.approvalsReviewer).toBe("user");
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
    const request = vi.fn(async (_method: string, _requestParams?: unknown) => ({
      thread: { id: "thread-1", cwd: tempDir },
      model: "openai/gpt-oss-20b",
      modelProvider: "lmstudio",
    }));
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(controlClient(request));

    await expect(
      setCodexConversationModel({
        sessionFile,
        model: "openai/gpt-oss-20b",
        pluginConfig: { appServer: { mode: "guardian" } },
      }),
    ).resolves.toBe("Codex model set to openai/gpt-oss-20b.");

    const resumeParams = request.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    const binding = await readCodexAppServerBinding(sessionFile);
    expect(resumeParams?.model).toBe("openai/gpt-oss-20b");
    expect(resumeParams?.modelProvider).toBe("lmstudio");
    expect(resumeParams?.approvalsReviewer).toBe("user");
    expect(binding?.modelProvider).toBe("lmstudio");
  });

  it("escapes model names returned from Codex before chat display", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "gpt-5.4",
      modelProvider: "openai",
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(
      controlClient(
        vi.fn(async () => ({
          thread: { id: "thread-1", cwd: tempDir },
          model: "gpt-5.5 <@U123> [trusted](https://evil)",
          modelProvider: "openai",
        })),
      ),
    );

    await expect(setCodexConversationModel({ sessionFile, model: "gpt-5.5" })).resolves.toBe(
      "Codex model set to gpt-5.5 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09.",
    );
  });
});
