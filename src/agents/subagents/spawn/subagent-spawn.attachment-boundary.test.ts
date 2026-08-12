import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

describe("subagent attachment owner boundaries", () => {
  const callGatewayMock = vi.fn();
  const updateSessionStoreMock = vi.fn();
  const content = Buffer.from("hello").toString("base64");
  const ctx = { agentSessionKey: "agent:main:main" };
  let workspaceDir = "";
  let config = createSubagentSpawnTestConfig();

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-attachment-boundary-"));
    config = createSubagentSpawnTestConfig(workspaceDir, {
      agents: {
        defaults: { workspace: workspaceDir, sandbox: { mode: "all", workspaceAccess: "rw" } },
      },
    });
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    updateSessionStoreMock.mockImplementation(async (_path: unknown, mutate: unknown) => {
      const store: Record<string, Record<string, unknown>> = {};
      await (mutate as (value: typeof store) => unknown)(store);
      return store;
    });
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  const runtimeLocalSandbox = (fsBridge: unknown) => ({
    backendId: "ssh",
    runtimeId: "runtime-main",
    backend: { configLabel: "worker@example.test" },
    fsBridge,
    workspaceDir,
    agentWorkspaceDir: workspaceDir,
  });

  const spawnAttachments = async (
    module: Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>,
    names = ["SKILL.md"],
  ) =>
    module.spawnSubagentDirect(
      {
        task: "test",
        attachments: names.map((name) => ({ name, content, encoding: "base64" as const })),
      },
      ctx,
    );

  it("rejects writable shared staging when the backend bridge is not pinned", async () => {
    const registerSubagentRunMock = vi.fn();
    const mutate = vi.fn();
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      updateSessionStoreMock,
      workspaceDir,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        backendId: "mxc",
        runtimeId: "sandbox-rw",
        backend: {
          configLabel: "mxc-process",
          capabilities: { workspaceMutationVisibility: "shared-host" },
          createFsBridge: vi.fn(),
        },
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        containerWorkdir: workspaceDir,
        docker: { binds: [] },
        fsBridge: { resolvePath: vi.fn(), mkdirp: mutate, createFileExclusive: mutate },
      }),
      registerSubagentRunMock,
    });

    expect(await spawnAttachments(module)).toMatchObject({
      status: "error",
      error: expect.stringContaining("confined attachment ingress"),
    });
    expect(registerSubagentRunMock).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("fails closed when writable-alias resolution cannot prove the receipt path", async () => {
    fs.symlinkSync(".openclaw", path.join(workspaceDir, ".openclaw"));
    const registerSubagentRunMock = vi.fn();
    const mutate = vi.fn();
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      updateSessionStoreMock,
      workspaceDir,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        backendId: "docker",
        runtimeId: "sandbox-rw",
        backend: {
          configLabel: "openclaw-sandbox:latest",
          capabilities: { workspaceMutationVisibility: "shared-host" },
        },
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        containerWorkdir: "/workspace",
        docker: { binds: [] },
        fsBridge: { resolvePath: vi.fn(), mkdirp: mutate, createFileExclusive: mutate },
      }),
      registerSubagentRunMock,
    });

    expect((await spawnAttachments(module)).status).toBe("error");
    expect(registerSubagentRunMock).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects a backend host ingress still writable through a peer boundary", async () => {
    const peerWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-peer-sandbox-"));
    const preparedRoot = path.join(peerWorkspace, "prepared-ingress");
    const registerSubagentRunMock = vi.fn();
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      updateSessionStoreMock,
      workspaceDir,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        backendId: "mxc",
        runtimeId: "sandbox-rw",
        backend: {
          configLabel: "mxc-process",
          capabilities: { workspaceMutationVisibility: "shared-host" },
          createFsBridge: vi.fn(),
        },
        workspaceDir,
        agentWorkspaceDir: workspaceDir,
        workspaceAccess: "rw",
        containerWorkdir: workspaceDir,
        docker: { binds: [] },
      }),
      listResolvedSandboxContexts: () => [
        {
          backendId: "docker",
          runtimeId: "peer-rw",
          sessionKey: "agent:peer:main",
          backend: {
            configLabel: "openclaw-sandbox:latest",
            capabilities: { workspaceMutationVisibility: "shared-host" },
          },
          workspaceDir: peerWorkspace,
          agentWorkspaceDir: peerWorkspace,
          workspaceAccess: "rw",
          containerWorkdir: "/peer",
          docker: { binds: [] },
        },
      ],
      getSandboxBackendManager: () => ({
        prepareAttachmentIngress: async () => ({
          workspaceDir: preparedRoot,
          sandboxAttachmentsRootDir: path.join(preparedRoot, ".openclaw", "attachments"),
          workspaceMutationVisibility: "shared-host" as const,
        }),
      }),
      registerSubagentRunMock,
    });

    expect(await spawnAttachments(module)).toMatchObject({
      status: "error",
      error: expect.stringContaining("writable through another sandbox boundary"),
    });
    expect(registerSubagentRunMock).not.toHaveBeenCalled();
    fs.rmSync(peerWorkspace, { recursive: true, force: true });
  });

  it("does not mutate the receipt path when the durable cleanup claim fails", async () => {
    const mutations: string[] = [];
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        relativePath: "",
        containerPath: filePath,
      }),
      mkdirp: async () => mutations.push("mkdir"),
      createFileExclusive: async () => {
        mutations.push("create");
        return "created" as const;
      },
      remove: async () => mutations.push("remove"),
    };
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      updateSessionStoreMock,
      workspaceDir,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => runtimeLocalSandbox(bridge),
      registerSubagentRunMock: vi.fn(() => {
        throw new Error("state database unavailable");
      }),
    });

    expect(await spawnAttachments(module, ["file.txt"])).toMatchObject({
      status: "error",
      error: "state database unavailable",
    });
    expect(mutations).toEqual([]);
    expect(callGatewayMock).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("retains the provisional owner when partial-write cleanup fails", async () => {
    let createCount = 0;
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        relativePath: "",
        containerPath: filePath,
      }),
      mkdirp: async ({ filePath }: { filePath: string }) => {
        await fs.promises.mkdir(filePath, { recursive: true, mode: 0o700 });
      },
      createFileExclusive: async ({
        filePath,
        data,
      }: {
        filePath: string;
        data: Buffer | string;
      }) => {
        createCount += 1;
        if (createCount === 2) {
          throw new Error("second write failed");
        }
        await fs.promises.writeFile(filePath, data, { flag: "wx", mode: 0o600 });
        return "created" as const;
      },
      remove: async () => {
        throw new Error("temporary cleanup failure");
      },
    };
    const registerSubagentRunMock = vi.fn();
    const settleFailedQueuedSubagentLaunchMock = vi.fn(() => true);
    const releaseSubagentRunMock = vi.fn(async () => undefined);
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => config,
      updateSessionStoreMock,
      workspaceDir,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => runtimeLocalSandbox(bridge),
      registerSubagentRunMock,
      settleFailedQueuedSubagentLaunchMock,
      releaseSubagentRunMock,
    });

    expect(await spawnAttachments(module, ["one.txt", "two.txt"])).toMatchObject({
      status: "error",
      error: "second write failed",
    });
    expect(registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ queued: true, attachmentsDir: expect.any(String) }),
    );
    expect(settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledTimes(1);
    expect(releaseSubagentRunMock).not.toHaveBeenCalled();
  });
});
