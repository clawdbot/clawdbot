import fs from "node:fs/promises";
import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildTestFactoryNativeAuthority } from "../../../../src/agents/factory-authority-profile.test-helpers.js";
import * as appServerPolicy from "./app-server-policy.js";
import * as bindingConnection from "./binding-connection.js";
import * as codexConfig from "./config.js";
import { prepareCodexAttemptConnection } from "./run-attempt-connection.js";
import { createParams, setupRunAttemptTestHooks, tempDir } from "./run-attempt-test-harness.js";
import {
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

setupRunAttemptTestHooks();

describe("prepareCodexAttemptConnection", () => {
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
    const readApprovalRequirements = vi.spyOn(
      codexConfig,
      "isCodexAppServerApprovalPolicyAllowedByRequirements",
    );
    const stat = vi.spyOn(fs, "stat");

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(connection.effectiveWorkspace).toBe(workspaceDir);
    expect(resolveConnection).toHaveBeenCalledTimes(1);
    expect(resolveModelPolicy).toHaveBeenCalledTimes(1);
    expect(readApprovalRequirements).not.toHaveBeenCalled();
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

  it("still checks enterprise requirements before promoting tool approvals", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: vi.fn() }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
    const readApprovalRequirements = vi.spyOn(
      codexConfig,
      "isCodexAppServerApprovalPolicyAllowedByRequirements",
    );

    const connection = await prepareCodexAttemptConnection({
      params,
      options: { bindingStore: testCodexAppServerBindingStore },
    });

    expect(readApprovalRequirements).toHaveBeenCalledOnce();
    expect(readApprovalRequirements).toHaveBeenCalledWith("untrusted");
    expect(connection.appServer.approvalPolicy).toBe("untrusted");
    expect(connection.approvalPolicyPromotedForOpenClawToolPolicy).toBe(true);
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
    expect(connection.approvalPolicyPromotedForOpenClawToolPolicy).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "revalidates factory connection policy when the current binding is re-resolved",
    async () => {
      const root = path.join(tempDir, "factory-current-binding");
      const authority = buildTestFactoryNativeAuthority(root);
      const runId = `swarm_${"b".repeat(32)}`;
      const sessionFile = path.join(tempDir, "factory-current-binding.jsonl");
      const params = createParams(sessionFile, authority.cwd, { runId });
      params.cwd = authority.cwd;
      params.agentDir = path.join(tempDir, "factory-agent");
      params.factoryNativeAuthority = {
        runId,
        launchIdentityDigest: `sha256:${"a".repeat(64)}`,
        authority,
      };
      registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
      const resolveConnection = vi.spyOn(
        bindingConnection,
        "resolveCodexBindingAppServerConnection",
      );

      const connection = await prepareCodexAttemptConnection({
        params,
        options: { bindingStore: testCodexAppServerBindingStore },
      });
      const initiallyResolved = resolveConnection.mock.results[0]?.value;
      if (!initiallyResolved) {
        throw new Error("expected the initial factory connection to resolve");
      }
      resolveConnection.mockReturnValue({
        ...initiallyResolved,
        appServer: { ...initiallyResolved.appServer, connectionClass: "remote" },
      });

      expect(() => connection.resolveRuntimeOptionsForCurrentBinding({})).toThrow(
        "factory native Codex runs require a local stdio app-server without a network proxy",
      );
    },
  );
});
