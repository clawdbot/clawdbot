import fs from "node:fs/promises";
import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import * as appServerPolicy from "./app-server-policy.js";
import * as bindingConnection from "./binding-connection.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createSandboxContext } from "./sandbox-exec-server.test-helpers.js";
import {
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

describe("prepareCodexAttemptConnection", () => {
  it("clears ambient GitHub service tokens for a native local profile", async () => {
    const sessionFile = path.join(tempDir, "native-local-process-env.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-native-local-process-env");
    const params = createParams(sessionFile, workspaceDir);
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      preparedEnvironment: () =>
        Object.freeze({
          credentialScrubEnv: Object.freeze({ GH_TOKEN: "", GITHUB_TOKEN: "" }),
        }),
    });
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(connection.appServer.start.env).toMatchObject({ GH_TOKEN: "", GITHUB_TOKEN: "" });
    expect(connection.shellEnvironment).toEqual({ GH_TOKEN: "", GITHUB_TOKEN: "" });
  });

  it("adds service credential scrubbing to remote execution", async () => {
    const sessionFile = path.join(tempDir, "remote-process-env.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-remote-process-env");
    const params = createParams(sessionFile, workspaceDir);
    params.hostCapabilities = Object.freeze({
      ...params.hostCapabilities,
      preparedEnvironment: () =>
        Object.freeze({
          credentialScrubEnv: Object.freeze({ GH_TOKEN: "", GITHUB_TOKEN: "" }),
        }),
    });
    params.sandbox = {
      ...createSandboxContext({}),
      placementExecutionMode: "remote-exec",
    } as NonNullable<typeof params.sandbox> & { placementExecutionMode: "remote-exec" };
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
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(connection.appServer.start.env).toMatchObject({ GH_TOKEN: "", GITHUB_TOKEN: "" });
    expect(connection.shellEnvironment).toEqual({ GH_TOKEN: "", GITHUB_TOKEN: "" });
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

  it("does not give OpenClaw ownership of an explicit operator approval policy", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const sessionFile = path.join(tempDir, "explicit-approval-policy.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-explicit-approval-policy");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);

    const connection = await prepareCodexAttemptConnection({
      params,
      options: {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: { approvalPolicy: "untrusted" } },
      },
    });

    expect(connection.appServer.approvalPolicy).toBe("untrusted");
  });
});
