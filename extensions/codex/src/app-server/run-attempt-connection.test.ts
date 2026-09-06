import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { patchSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import * as appServerPolicy from "./app-server-policy.js";
import { applyCodexAppServerAuthProfile } from "./auth-bridge.js";
import * as bindingConnection from "./binding-connection.js";
import * as codexRequirements from "./config-requirements.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  createCodexTestBindingStore,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { withCodexThreadLifecycleBinding } from "./thread-lifecycle-adoption.js";

setupRunAttemptTestHooks();

describe("prepareCodexAttemptConnection", () => {
  it("retains the recovered generation fence after connection preparation", async () => {
    const workspaceDir = path.join(tempDir, "recovered-workspace");
    const params = createParams(path.join(tempDir, "recovered.jsonl"), workspaceDir);
    const current = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: params.sessionKey!,
      sessionId: params.sessionId,
    };
    const previous = { ...current, sessionId: "before-compaction" };
    const scope = {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: path.join(tempDir, "admitted", "sessions.json"),
    };
    params.sessionTarget = { ...scope, sessionId: current.sessionId };
    await upsertSessionEntry({ ...scope, entry: { sessionId: previous.sessionId, updatedAt: 1 } });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: current.sessionId }) });
    const bindingStore = createCodexTestBindingStore();
    const binding = { threadId: "recovered-native-thread", cwd: workspaceDir };
    await bindingStore.mutate(previous, { kind: "set", binding });
    const originalHostCapabilities = params.hostCapabilities;

    const connection = await prepareCodexAttemptConnection({ params, options: { bindingStore } });
    expect(bindingStore.read(current)).toEqual(binding);
    expect(connection.params.hostCapabilities).toBe(originalHostCapabilities);
    expect(() => connection.assertCurrent()).not.toThrow();
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: "next-compaction" }) });

    expect(() => originalHostCapabilities.assertActive()).not.toThrow();
    expect(() => connection.assertCurrent()).toThrow(
      "Codex session generation is no longer current",
    );
    expect(bindingStore.read(current)).toEqual(binding);
  });

  it.each(["missing", "ordinary", "auth-changed", "model-changed", "provider-changed"] as const)(
    "rejects %s expected native ownership before reclaim or connection preparation",
    async (state) => {
      const sessionFile = path.join(tempDir, "expected-ownership.jsonl");
      const workspaceDir = path.join(tempDir, "expected-ownership-workspace");
      const params = createParams(sessionFile, workspaceDir);
      const expectedOwnership = {
        model: "native" as const,
        auth: state === "auth-changed" ? ("native" as const) : ("host" as const),
        modelRef: { provider: "openai", model: "gpt-5.6-luna" },
      };
      params.expectedSessionRuntimeOwnership = expectedOwnership;
      registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
      if (state !== "missing") {
        await writeCodexAppServerBinding(sessionFile, {
          threadId: "thread-existing",
          cwd: workspaceDir,
          ...(state !== "ordinary" ? { preserveNativeModel: true } : {}),
          model: state === "model-changed" ? "gpt-5.6-sol" : "gpt-5.6-luna",
          modelProvider: state === "provider-changed" ? "other-native-provider" : "openai",
        });
      }
      const before = await readCodexAppServerBinding(sessionFile);
      const reclaim = vi.spyOn(testCodexAppServerBindingStore, "prepareSessionGenerationReclaim");
      const connect = vi
        .spyOn(bindingConnection, "resolveCodexBindingAppServerConnection")
        .mockImplementation(() => {
          throw new Error("invalid ownership reached connection preparation");
        });

      await expect(
        prepareCodexAttemptConnection({
          params,
          options: { bindingStore: testCodexAppServerBindingStore },
        }),
      ).rejects.toMatchObject({
        name: "AgentHarnessPreflightError",
        message: expect.stringContaining("Reattach the original native session"),
      });
      expect(reclaim).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toEqual(before);
    },
  );

  it.each([
    "preserved",
    "missing",
    "ordinary",
    "auth-changed",
    "model-changed",
    "provider-changed",
  ] as const)(
    "rechecks %s native ownership after acquiring the lifecycle binding lease",
    async (state) => {
      const sessionFile = path.join(tempDir, "leased-ownership.jsonl");
      const workspaceDir = path.join(tempDir, "leased-ownership-workspace");
      const params = createParams(sessionFile, workspaceDir);
      const expectedOwnership = {
        model: "native" as const,
        auth: "host" as const,
        modelRef: { provider: "openai", model: "gpt-5.6-luna" },
      };
      params.expectedSessionRuntimeOwnership = expectedOwnership;
      registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        preserveNativeModel: true,
        model: "gpt-5.6-luna",
        modelProvider: "openai",
      });
      const bindingStore = testCodexAppServerBindingStore;
      const withLease = bindingStore.withLease.bind(bindingStore);
      vi.spyOn(bindingStore, "withLease").mockImplementationOnce(async (identity, run) => {
        // The initial snapshot is valid; simulate retirement/replacement while awaiting its lease.
        if (state === "missing") {
          await bindingStore.mutate(identity, { kind: "clear", threadId: "thread-existing" });
        } else if (state !== "preserved") {
          await bindingStore.mutate(identity, {
            kind: "patch",
            threadId: "thread-existing",
            patch:
              state === "ordinary"
                ? { preserveNativeModel: undefined }
                : state === "model-changed"
                  ? { model: "gpt-5.6-sol" }
                  : state === "provider-changed"
                    ? { modelProvider: "other-native-provider" }
                    : {
                        connectionScope: "supervision",
                        supervisionSourceThreadId: "native-source",
                        conversationSourceTransferComplete: true,
                        model: "native-model",
                        modelProvider: "native-provider",
                      },
          });
        }
        return withLease(identity, run);
      });
      const execute = vi.fn<Parameters<typeof withCodexThreadLifecycleBinding>[1]>(
        async (_identity, binding) => {
          if (!binding) {
            throw new Error("native execution received no binding");
          }
          return { ...binding, lifecycle: { action: "resumed" } };
        },
      );
      const operation = withCodexThreadLifecycleBinding(
        {
          params,
          bindingStore,
          client: {} as never,
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: resolveCodexAppServerRuntimeOptions({ env: {}, requirementsToml: null }),
        },
        execute,
      );

      if (state === "preserved") {
        await expect(operation).resolves.toMatchObject({ preserveNativeModel: true });
        expect(execute).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toMatchObject({ name: "AgentHarnessPreflightError" });
        expect(execute).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    "local",
    "loopback-server",
    "ordinary-loopback-server",
    "forwarded-server",
    "unix-server",
    "remote-server",
    "sandbox",
    "remote",
    "remote-only",
  ])("handles an installation target for %s execution before native startup", async (placement) => {
    const sessionFile = path.join(tempDir, "installation-target.jsonl");
    const params = createParams(sessionFile, path.join(tempDir, "workspace-installation-target"));
    const localProcessEnv = Object.freeze({
      OPENCLAW_STATE_DIR: "/fixture/diagnosed",
      OPENCLAW_CONFIG_PATH: "/fixture/custom.json",
      OPENCLAW_WORKSPACE_DIR: "/fixture/default-workspace",
    });
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      preparedEnvironment: () => ({
        credentialScrubEnv: {},
        localIdentityEnv: {},
        managedLocalIdentity: false,
        localProcessEnv: placement === "ordinary-loopback-server" ? undefined : localProcessEnv,
      }),
    });
    if (["sandbox", "remote", "remote-only"].includes(placement)) {
      params.sandbox = {
        ...createSandboxContext({}),
        ...(placement.startsWith("remote") ? { placementExecutionMode: "remote-exec" } : {}),
        ...(placement === "remote-only" ? { enabled: false } : {}),
      } as NonNullable<typeof params.sandbox>;
    }
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
    const pending = prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        ...(placement.endsWith("-server")
          ? {
              pluginConfig: {
                appServer:
                  placement === "unix-server"
                    ? { transport: "unix", homeScope: "user", url: "unix:///fixture/native.sock" }
                    : {
                        transport: "websocket",
                        url:
                          placement === "remote-server"
                            ? "wss://fixture.invalid/native"
                            : "ws://127.0.0.1:19400",
                        authToken: "fixture-token",
                        ...(placement === "forwarded-server"
                          ? { remoteWorkspaceRoot: "/remote/workspace" }
                          : {}),
                      },
              },
            }
          : {}),
      },
    });
    if (!["local", "ordinary-loopback-server", "unix-server"].includes(placement)) {
      await expect(pending).rejects.toThrow("saved prompt");
      return;
    }
    const connection = await pending;
    if (placement === "ordinary-loopback-server") {
      expect(connection.shellEnvironment).toBeUndefined();
      expect(connection.appServer.start.env ?? {}).not.toHaveProperty("OPENCLAW_STATE_DIR");
      expect(connection.disableLoginShell).toBe(false);
      return;
    }
    expect(connection.shellEnvironment).toEqual(localProcessEnv);
    expect(connection.appServer.start.env).toMatchObject(localProcessEnv);
    expect(connection.disableLoginShell).toBe(true);
  });
  it("preserves native process environment and login-shell behavior for an empty overlay", async () => {
    const sessionFile = path.join(tempDir, "native-local-no-overlay.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-native-local-no-overlay");
    const params = createParams(sessionFile, workspaceDir);
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      preparedEnvironment: () =>
        Object.freeze({
          credentialScrubEnv: Object.freeze({}),
          localIdentityEnv: Object.freeze({}),
          managedLocalIdentity: false,
        }),
    });
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(connection.shellEnvironment).toBeUndefined();
    expect(connection.disableLoginShell).toBe(false);
  });

  it("disables login shells for custom credential scrub overlays", async () => {
    const sessionFile = path.join(tempDir, "native-local-custom-scrub.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-native-local-custom-scrub");
    const params = createParams(sessionFile, workspaceDir);
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      preparedEnvironment: () =>
        Object.freeze({
          credentialScrubEnv: Object.freeze({ PREVIEW_STORE_TOKEN: "" }),
          localIdentityEnv: Object.freeze({}),
          managedLocalIdentity: false,
        }),
    });
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(connection.shellEnvironment).toEqual({ PREVIEW_STORE_TOKEN: "" });
    expect(connection.disableLoginShell).toBe(true);
  });

  it.each(["local", "sandbox", "remote"] as const)(
    "projects managed identity only to local execution: %s",
    async (location) => {
      const sessionFile = path.join(tempDir, `${location}-process-env.jsonl`);
      const workspaceDir = path.join(tempDir, `workspace-${location}-process-env`);
      const params = createParams(sessionFile, workspaceDir);
      const credentialScrubEnv = { GH_TOKEN: "", GITHUB_TOKEN: "", PREVIEW_SERVICE_TOKEN: "" };
      const localIdentityEnv = {
        GH_CONFIG_DIR: "/private/managed-gh",
        GIT_AUTHOR_NAME: "Managed Author",
        GIT_AUTHOR_EMAIL: "managed@example.test",
        GIT_COMMITTER_NAME: "Managed Committer",
        GIT_COMMITTER_EMAIL: "committer@example.test",
      };
      params.hostCapabilities = Object.freeze({
        ...params.hostCapabilities,
        preparedEnvironment: () =>
          Object.freeze({
            credentialScrubEnv: Object.freeze(credentialScrubEnv),
            localIdentityEnv: Object.freeze(localIdentityEnv),
            managedLocalIdentity: true,
          }),
      });
      if (location !== "local") {
        params.sandbox = {
          ...createSandboxContext({}),
          ...(location === "remote" ? { placementExecutionMode: "remote-exec" } : {}),
        } as NonNullable<typeof params.sandbox>;
      }
      if (location === "remote") {
        const runtimePlan = createCodexRuntimePlanFixture();
        params.runtimePlan = {
          ...runtimePlan,
          auth: {
            ...runtimePlan.auth,
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            selectedAuthMode: "api-key",
            modelRoute: {
              provider: "openai",
              modelId: "gpt-5.6-luna",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: "none",
            },
          },
        };
        params.resolvedApiKey = "prepared-test-key";
      }
      registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

      const connection = await prepareCodexAttemptConnection({
        params,
        options: { bindingStore: testCodexAppServerBindingStore },
      });

      expect(connection.shellEnvironment).toEqual({
        ...credentialScrubEnv,
        ...(location === "local" ? localIdentityEnv : {}),
      });
      expect(connection.appServer.start.env).toMatchObject(connection.shellEnvironment!);
      if (location !== "local") {
        for (const key of Object.keys(localIdentityEnv)) {
          expect(connection.appServer.start.env).not.toHaveProperty(key);
        }
      }
      expect(connection.disableLoginShell).toBe(true);
    },
  );

  it.each([
    {
      name: "paired-device remote execution",
      placement: { placementExecutionMode: "remote-exec", placementNodeId: "paired-device-1" },
      expectedFactory: createIsolatedCodexAppServerClient,
    },
    {
      name: "SSH remote execution",
      placement: { placementExecutionMode: "remote-exec" },
      expectedFactory: getLeasedSharedCodexAppServerClient,
    },
    {
      name: "local sandbox execution",
      placement: {},
      expectedFactory: getLeasedSharedCodexAppServerClient,
    },
  ])(
    "selects the correct app-server ownership for $name",
    async ({ placement, expectedFactory }) => {
      const sessionFile = path.join(
        tempDir,
        `client-ownership-${placement.placementNodeId ?? "other"}.jsonl`,
      );
      const workspaceDir = path.join(
        tempDir,
        `workspace-client-ownership-${placement.placementNodeId ?? "other"}`,
      );
      const params = createParams(sessionFile, workspaceDir);
      params.sandbox = { ...createSandboxContext({}), ...placement } as NonNullable<
        typeof params.sandbox
      >;
      if (placement.placementExecutionMode === "remote-exec") {
        const runtimePlan = createCodexRuntimePlanFixture();
        params.runtimePlan = {
          ...runtimePlan,
          auth: {
            ...runtimePlan.auth,
            providerForAuth: "openai",
            authProfileProviderForAuth: "openai",
            selectedAuthMode: "api-key",
            modelRoute: {
              provider: "openai",
              modelId: "gpt-5.4-codex",
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              authRequirement: "api-key",
              requestTransportOverrides: "none",
            },
          },
        };
        params.resolvedApiKey = "prepared-test-key";
      }
      registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

      const connection = await prepareCodexAttemptConnection({
        params,
        options: { bindingStore: testCodexAppServerBindingStore },
      });

      expect(connection.attemptClientFactory).toBe(expectedFactory);
    },
  );

  it("keeps a user-home subscription on native account verification", async () => {
    const sessionFile = path.join(tempDir, "user-home-native-auth.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-user-home-native-auth");
    const params = createParams(sessionFile, workspaceDir);
    const runtimePlan = createCodexRuntimePlanFixture();
    params.runtimePlan = {
      ...runtimePlan,
      auth: {
        ...runtimePlan.auth,
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:unusable",
        selectedAuthMode: "subscription",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.4-codex",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
    };
    params.authProfileStore = {
      version: 1,
      profiles: {
        "openai:unusable": { type: "api_key", provider: "openai", key: "" },
      },
    };
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const connection = await prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: { homeScope: "user" } },
      },
    });
    const request = vi.fn(async (_method: string, _params?: unknown) => ({
      account: { type: "chatgpt" },
    }));

    expect(connection.startupAuthProfileId).toBeUndefined();
    expect(connection.startupPreparedAuth).toBeUndefined();
    expect(connection.startupClientAuthProfileId).toBeNull();
    await expect(
      applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir: connection.agentDir,
        authProfileId: connection.startupClientAuthProfileId,
        authRequirement: connection.startupAuthRequirement,
      }),
    ).resolves.toBeUndefined();
    expect(
      request.mock.calls.map(([method, requestParams]) => ({ method, params: requestParams })),
    ).toEqual([{ method: "account/read", params: { refreshToken: false } }]);
  });

  it.each([
    { name: "fresh thread", existingThread: false },
    { name: "unchanged resumed thread", existingThread: true },
  ])("resolves a $name and its workspace only once", async ({ existingThread }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
    if (existingThread) {
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: params.modelId,
        modelProvider: "openai",
      });
    }

    const resolveConnection = vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection");
    const resolveModelPolicy = vi.spyOn(appServerPolicy, "resolveCodexAppServerForModelProvider");
    const stat = vi.spyOn(fs, "stat");

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(connection.effectiveWorkspace).toBe(workspaceDir);
    expect(resolveConnection).toHaveBeenCalledTimes(1);
    expect(resolveModelPolicy).toHaveBeenCalledTimes(1);
    expect(stat.mock.calls.filter(([candidate]) => candidate === workspaceDir)).toHaveLength(0);
    expect(connection.mutable.startupBinding?.threadId).toBe(
      existingThread ? "thread-existing" : undefined,
    );
  });

  it("re-resolves model and connection policy when an oversized thread rotates", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = agentDir;
    params.config = {
      agents: {
        defaults: {
          compaction: {
            maxActiveTranscriptBytes: "1mb",
          },
        },
      },
    };
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: params.modelId,
      modelProvider: "openai",
    });
    const rolloutDir = path.join(agentDir, "codex-home", "sessions");
    await fs.mkdir(rolloutDir, { recursive: true });
    await fs.writeFile(
      path.join(rolloutDir, "rollout-thread-existing.jsonl"),
      "x".repeat(1_048_577),
    );

    const resolveConnection = vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection");
    const resolveModelPolicy = vi.spyOn(appServerPolicy, "resolveCodexAppServerForModelProvider");

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(connection.mutable.startupBinding).toBeUndefined();
    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(resolveModelPolicy).toHaveBeenCalledTimes(2);
  });

  it.each(["during rotation", "after rejection"] as const)(
    "releases a failed connection's abort listener when cancelled %s",
    async (cancelAt) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const agentDir = path.join(tempDir, "agent");
      const params = createParams(sessionFile, workspaceDir);
      params.agentDir = agentDir;
      params.config = {
        agents: { defaults: { compaction: { maxActiveTranscriptBytes: "1mb" } } },
      };
      const controller = new AbortController();
      params.abortSignal = controller.signal;
      params.onAttemptAbort = vi.fn();
      const upstreamListeners = getEventListeners(controller.signal, "abort").length;
      registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: params.modelId,
        modelProvider: "openai",
      });
      const rolloutDir = path.join(agentDir, "codex-home", "sessions");
      await fs.mkdir(rolloutDir, { recursive: true });
      await fs.writeFile(
        path.join(rolloutDir, "rollout-thread-existing.jsonl"),
        "x".repeat(1_048_577),
      );
      const rotationError = new Error("synthetic startup binding mutation failure");
      const mutate = vi
        .spyOn(testCodexAppServerBindingStore, "mutate")
        .mockImplementationOnce(async () => {
          if (cancelAt === "during rotation") {
            controller.abort("cancelled during rotation");
            expect(params.onAttemptAbort).toHaveBeenCalledTimes(1);
          }
          throw rotationError;
        });

      try {
        await expect(
          prepareCodexAttemptConnection({
            params,
            options: { bindingStore: testCodexAppServerBindingStore },
          }),
        ).rejects.toBe(rotationError);
        expect(mutate).toHaveBeenCalledWith(
          expect.anything(),
          { kind: "clear", threadId: "thread-existing" },
          expect.any(Function),
        );
        const remainingListeners = getEventListeners(controller.signal, "abort").length;
        controller.abort("cancelled after rejection");
        expect({
          remainingListeners,
          abortNotifications: vi.mocked(params.onAttemptAbort).mock.calls.length,
        }).toEqual({
          remainingListeners: upstreamListeners,
          abortNotifications: cancelAt === "during rotation" ? 1 : 0,
        });
      } finally {
        controller.abort("test cleanup");
      }
    },
  );

  it("rejects the retired explicit untrusted approval policy with Doctor remediation", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const sessionFile = path.join(tempDir, "explicit-approval-policy.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-explicit-approval-policy");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    await expect(
      prepareCodexAttemptConnection({
        params,
        options: {
          bindingStore: testCodexAppServerBindingStore,
          pluginConfig: { appServer: { approvalPolicy: "untrusted" } },
        },
      }),
    ).rejects.toThrow(
      'plugins.entries.codex.config.appServer.approvalPolicy="untrusted" is retired; run "openclaw doctor --fix" to migrate it to "on-request".',
    );
  });

  it("defaults a rootless workspace session boundary while overriding full exec", async () => {
    const sessionFile = path.join(tempDir, "workspace-session-policy.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-session-policy");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    params.config = { tools: { exec: { mode: "full" } } };
    // Dispatch owns mode→exec preparation; connection consumes the prepared override.
    params.execOverrides = { ...params.execOverrides, mode: "auto" };
    params.permissionMode = "workspace";
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const resolveConnection = vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection");
    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(resolveConnection).toHaveBeenCalledWith(
      expect.objectContaining({ execPolicy: expect.objectContaining({ mode: "auto" }) }),
    );
    expect(connection.appServer).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      sessionRoot: workspaceDir,
    });
    expect(connection.effectiveCwd).toBe(workspaceDir);
  });

  it("keeps a full session mode on never when a before_tool_call hook is present", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const sessionFile = path.join(tempDir, "full-session-hook-policy.jsonl");
    const workspaceDir = path.join(tempDir, "full-session-hook-policy");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    params.permissionMode = "full";
    params.sessionRoot = workspaceDir;
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    // Upstream 28f10c00b4e keeps YOLO approvals disabled despite generic tool hooks.
    expect(connection.appServer.approvalPolicy).toBe("never");
  });

  it("rejects native execution denied by the retained global policy owner", async () => {
    const workspaceDir = path.join(tempDir, "policy-workspace");
    const sessionFile = path.join(tempDir, "policy-session.jsonl");
    const params = createParams(sessionFile, workspaceDir);
    params.agentId = "main";
    params.agentDir = path.join(tempDir, "main-agent");
    params.sandboxSessionKey = "global";
    params.sandboxAgentId = "policy";
    params.config = {
      agents: {
        entries: {
          main: {},
          policy: { tools: { exec: { mode: "deny" } } },
        },
      },
    };
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    await expect(
      prepareCodexAttemptConnection({
        params,
        options: { bindingStore: testCodexAppServerBindingStore },
      }),
    ).rejects.toThrow("effective tools.exec.mode=deny");
  });

  it("prepares one Guardian policy when requirements clamp an explicitly full session", async () => {
    vi.mocked(codexRequirements.readCodexRequirementsToml).mockReturnValue(
      [
        'allowed_sandbox_modes = ["workspace-write"]',
        'allowed_approval_policies = ["on-request"]',
        'allowed_approvals_reviewers = ["auto_review"]',
      ].join("\n"),
    );
    const workspaceDir = path.join(tempDir, "requirements-clamped-workspace");
    const sessionFile = path.join(tempDir, "requirements-clamped-session.jsonl");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    params.provider = "openai";
    params.permissionMode = "full";
    params.sessionRoot = workspaceDir;
    params.execOverrides = { ...params.execOverrides, mode: "full" };
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(connection.appServer).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    });
    expect(connection.sessionPermissionPolicy).toEqual({
      mode: "workspace",
      root: workspaceDir,
      execMode: "auto",
    });
    expect(params).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: workspaceDir,
      execOverrides: { mode: "auto" },
    });
  });

  it.each([
    { permissionMode: "read-only" as const, execMode: "deny" as const },
    { permissionMode: "guarded" as const, execMode: "ask" as const },
  ])(
    "does not preflight-kill a $permissionMode session mode for denied global exec",
    async ({ permissionMode, execMode }) => {
      const sessionFile = path.join(tempDir, `${permissionMode}-session-policy.jsonl`);
      const workspaceDir = path.join(tempDir, `${permissionMode}-session-policy`);
      const params = createParams(sessionFile, workspaceDir);
      params.agentDir = path.join(tempDir, "agent");
      params.config = { tools: { exec: { mode: "deny" } } };
      params.execOverrides = { ...params.execOverrides, mode: execMode };
      params.permissionMode = permissionMode;
      params.sessionRoot = workspaceDir;
      registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
      const resolveConnection = vi.spyOn(
        bindingConnection,
        "resolveCodexBindingAppServerConnection",
      );

      const connection = await prepareCodexAttemptConnection({
        params,
        options: { bindingStore: testCodexAppServerBindingStore },
      });

      expect(connection).toBeDefined();
      expect(resolveConnection).toHaveBeenCalledWith(
        expect.objectContaining({ execPolicy: expect.objectContaining({ mode: execMode }) }),
      );
    },
  );
});
