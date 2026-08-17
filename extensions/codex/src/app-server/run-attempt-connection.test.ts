import fs from "node:fs/promises";
import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import * as appServerPolicy from "./app-server-policy.js";
import * as bindingConnection from "./binding-connection.js";
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

  it("lets a workspace session mode override explicitly configured full exec", async () => {
    const sessionFile = path.join(tempDir, "workspace-session-policy.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-session-policy");
    const params = createParams(sessionFile, workspaceDir);
    params.agentDir = path.join(tempDir, "agent");
    params.config = { tools: { exec: { mode: "full" } } };
    // Dispatch owns mode→exec preparation; connection consumes the prepared override.
    params.execOverrides = { ...params.execOverrides, mode: "auto" };
    params.permissionMode = "workspace";
    params.sessionRoot = workspaceDir;
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
