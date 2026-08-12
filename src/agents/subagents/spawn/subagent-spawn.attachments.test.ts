// Subagent spawn attachment tests cover strict base64 decoding, attachment name
// validation, materialization paths, and cleanup after spawn failures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../../test-utils/env.js";
import { reserveChildAdmissionSlot } from "../../child-admission.js";
import { resolveSandboxAttachmentIngressWorkspace } from "../../sandbox/attachment-ingress.js";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

const callGatewayMock = vi.fn();
const updateSessionStoreMock = vi.fn();

let configOverride = createSubagentSpawnTestConfig();
let workspaceDirOverride = "";
let subagentSpawnModule: Awaited<ReturnType<typeof loadSubagentSpawnModuleForTest>>;

beforeAll(async () => {
  subagentSpawnModule = await loadSubagentSpawnModuleForTest({
    callGatewayMock,
    getRuntimeConfig: () => configOverride,
    updateSessionStoreMock,
    workspaceDir: workspaceDirOverride || os.tmpdir(),
  });
});

describe("spawnSubagentDirect filename validation", () => {
  beforeEach(async () => {
    workspaceDirOverride = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-attachments-${process.pid}-${Date.now()}-`),
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", workspaceDirOverride);
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride);
    subagentSpawnModule.resetSubagentRegistryForTests();
    callGatewayMock.mockClear();
    updateSessionStoreMock.mockReset();
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      return store;
    });
    setupAcceptedSubagentGatewayMock(callGatewayMock);
  });

  afterEach(() => {
    if (workspaceDirOverride) {
      fs.rmSync(workspaceDirOverride, { recursive: true, force: true });
      workspaceDirOverride = "";
    }
    vi.unstubAllEnvs();
  });

  const ctx = {
    agentSessionKey: "agent:main:main",
    agentChannel: "forum" as const,
    agentAccountId: "123",
    agentTo: "456",
  };

  const validContent = Buffer.from("hello").toString("base64");

  const runtimeLocalSandbox = (fsBridge: unknown) => ({
    backendId: "ssh",
    runtimeId: "runtime-main",
    backend: {
      configLabel: "worker@example.test",
    },
    fsBridge,
  });

  async function spawnWithName(name: string) {
    const { spawnSubagentDirect } = subagentSpawnModule;
    return spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name, content: validContent, encoding: "base64" }],
      },
      ctx,
    );
  }

  it("stages unsandboxed attachments outside an explicit cwd", async () => {
    const explicitWorkspaceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-cwd-attachments-${process.pid}-${Date.now()}-`),
    );
    try {
      const { spawnSubagentDirect } = subagentSpawnModule;
      const result = await spawnSubagentDirect(
        {
          task: "test",
          cwd: explicitWorkspaceDir,
          attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
        },
        ctx,
      );

      expect(result.status).toBe("accepted");
      const privateWorkspace = resolveSandboxAttachmentIngressWorkspace(
        result.childSessionKey as string,
      );
      const privateAttachmentsRoot = path.join(privateWorkspace, ".openclaw", "attachments");
      const explicitAttachmentsRoot = path.join(explicitWorkspaceDir, ".openclaw", "attachments");
      const targetAttachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
      expect(fs.existsSync(privateAttachmentsRoot)).toBe(true);
      expect(fs.existsSync(explicitAttachmentsRoot)).toBe(false);
      expect(fs.existsSync(targetAttachmentsRoot)).toBe(false);
      if (process.platform !== "win32") {
        const [receiptDir] = fs.readdirSync(privateAttachmentsRoot);
        expect(receiptDir).toBeTypeOf("string");
        if (!receiptDir) {
          throw new Error("missing attachment receipt directory");
        }
        for (const privateDir of [
          path.join(privateWorkspace, ".openclaw"),
          privateAttachmentsRoot,
          path.join(privateAttachmentsRoot, receiptDir),
        ]) {
          expect(fs.statSync(privateDir).mode & 0o777).toBe(0o700);
        }
      }
    } finally {
      fs.rmSync(explicitWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("materializes writable-sandbox attachments through the confined filesystem bridge", async () => {
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: {
        defaults: {
          workspace: workspaceDirOverride,
          sandbox: { mode: "all", workspaceAccess: "rw" },
        },
      },
    });
    const bridgeCalls: string[] = [];
    let concurrentReservationAccepted = false;
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        hostPath: filePath,
        relativePath: "",
        containerPath: filePath,
      }),
      mkdirp: async ({ filePath, mode }: { filePath: string; mode?: number }) => {
        bridgeCalls.push(`mkdir:${mode?.toString(8)}`);
        const probe = reserveChildAdmissionSlot({
          controllerSessionKey: ctx.agentSessionKey,
          resolveAdmission: (pendingChildren) =>
            pendingChildren === 0 ? ({ ok: true } as const) : ({ ok: false } as const),
        });
        concurrentReservationAccepted = probe.ok;
        if (probe.ok) {
          probe.release();
        }
        await fs.promises.mkdir(filePath, { recursive: true, mode });
      },
      createFileExclusive: async ({
        filePath,
        data,
      }: {
        filePath: string;
        data: Buffer | string;
      }) => {
        bridgeCalls.push(`create:${path.basename(filePath)}`);
        try {
          await fs.promises.writeFile(filePath, data, { flag: "wx", mode: 0o600 });
          return "created" as const;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return "exists" as const;
          }
          throw error;
        }
      },
      remove: async ({ filePath }: { filePath: string }) => {
        bridgeCalls.push("remove");
        await fs.promises.rm(filePath, { recursive: true, force: true });
      },
    };
    const registerSubagentRunMock = vi.fn(() => bridgeCalls.push("claim"));
    const prepareFsCleanupLocator = vi.fn(async () => ({
      version: 1,
      generation: "runtime-generation",
    }));
    const createFsCleanupBridge = vi.fn(async () => bridge);
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => runtimeLocalSandbox(bridge),
      getSandboxBackendManager: () => ({
        prepareFsCleanupLocator,
        createFsCleanupBridge,
      }),
      registerSubagentRunMock,
    });

    const result = await sandboxedSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result.status).toBe("accepted");
    expect(bridgeCalls.indexOf("claim")).toBeLessThan(bridgeCalls.indexOf("mkdir:700"));
    expect(concurrentReservationAccepted).toBe(true);
    expect(bridgeCalls).toContain("mkdir:700");
    expect(bridgeCalls).toContain("create:file.txt");
    expect(bridgeCalls).toContain("create:.manifest.json");
    expect(prepareFsCleanupLocator).toHaveBeenCalledOnce();
    expect(createFsCleanupBridge).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(workspaceDirOverride, ".openclaw", "attachments"))).toBe(true);
    expect(registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentsSandboxSessionKey: expect.stringContaining(":subagent:"),
        attachmentsSandboxAgentId: "main",
        attachmentsSandboxWorkspaceDir: workspaceDirOverride,
        attachmentsSandboxIdentity: expect.objectContaining({
          backendId: "ssh",
          runtimeId: "runtime-main",
          fsCleanupLocator: expect.anything(),
        }),
        attachmentsSandboxDir: expect.stringContaining("/.openclaw/attachments/"),
        launchCleanupPending: true,
        launchCleanupSessionIdentity: {
          sessionId: expect.any(String),
          lifecycleRevision: expect.any(String),
        },
      }),
    );
    expect(callGatewayMock).toHaveBeenCalled();
  });

  it("stages a nested cross-agent receipt through the child-owned bridge", async () => {
    const workerWorkspaceDir = path.join(workspaceDirOverride, "worker");
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: {
        defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } },
        list: [
          {
            id: "main",
            workspace: workspaceDirOverride,
            subagents: { allowAgents: ["worker"] },
          },
          { id: "worker", workspace: workerWorkspaceDir },
        ],
      },
    });
    const bridgeCalls: string[] = [];
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        hostPath: filePath,
        relativePath: "",
        containerPath: filePath,
      }),
      mkdirp: async ({ filePath }: { filePath: string }) => {
        bridgeCalls.push(`mkdir:${filePath}`);
        expect(fs.existsSync(workerWorkspaceDir)).toBe(false);
        await fs.promises.mkdir(filePath, { recursive: true, mode: 0o700 });
      },
      createFileExclusive: async ({
        filePath,
        data,
      }: {
        filePath: string;
        data: Buffer | string;
      }) => {
        bridgeCalls.push(`create:${filePath}`);
        await fs.promises.writeFile(filePath, data, { flag: "wx", mode: 0o600 });
        return "created" as const;
      },
      remove: async ({ filePath }: { filePath: string }) => {
        await fs.promises.rm(filePath, { recursive: true, force: true });
      },
    };
    const resolveSandboxContext = vi.fn(async () => runtimeLocalSandbox(bridge));
    const registerSubagentRunMock = vi.fn();
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext,
      registerSubagentRunMock,
    });

    const result = await sandboxedSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        agentId: "worker",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result.status).toBe("accepted");
    expect(resolveSandboxContext).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "worker",
        sessionKey: expect.stringContaining(":subagent:"),
        workspaceDir: workerWorkspaceDir,
      }),
    );
    expect(bridgeCalls.some((call) => call.includes(workerWorkspaceDir))).toBe(true);
    expect(registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentsSandboxAgentId: "worker",
        attachmentsSandboxWorkspaceDir: workerWorkspaceDir,
        attachmentsSandboxDir: expect.stringContaining("/.openclaw/attachments/"),
      }),
    );
  });

  it("uses child-private ingress for a writable cross-agent bind", async () => {
    const bindRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-bind-attachments-${process.pid}-${Date.now()}-`),
    );
    const workerWorkspaceDir = path.join(bindRoot, "worker");
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            workspaceAccess: "rw",
            docker: { binds: [`${bindRoot}:/mnt/shared:rw`] },
          },
        },
        list: [
          {
            id: "main",
            workspace: workspaceDirOverride,
            subagents: { allowAgents: ["worker"] },
          },
          { id: "worker", workspace: workerWorkspaceDir },
        ],
      },
    });
    const bridgeCalls: string[] = [];
    const toHostPath = (filePath: string) =>
      filePath.startsWith("/mnt/shared")
        ? path.join(bindRoot, path.relative("/mnt/shared", filePath))
        : filePath;
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        hostPath: toHostPath(filePath),
        relativePath: "",
        containerPath: filePath,
      }),
      mkdirp: async ({ filePath }: { filePath: string }) => {
        bridgeCalls.push(`mkdir:${filePath}`);
        await fs.promises.mkdir(toHostPath(filePath), { recursive: true, mode: 0o700 });
      },
      createFileExclusive: async ({
        filePath,
        data,
      }: {
        filePath: string;
        data: Buffer | string;
      }) => {
        bridgeCalls.push(`create:${filePath}`);
        await fs.promises.writeFile(toHostPath(filePath), data, { flag: "wx", mode: 0o600 });
        return "created" as const;
      },
      remove: async ({ filePath }: { filePath: string }) => {
        await fs.promises.rm(toHostPath(filePath), { recursive: true, force: true });
      },
    };
    const resolveSandboxContext = vi.fn(async (params: unknown) => {
      const agentId = (params as { agentId?: string }).agentId;
      if (agentId === "worker") {
        return {
          backendId: "docker",
          runtimeId: "worker-ro",
          backend: {
            configLabel: "openclaw-sandbox:latest",
            capabilities: { workspaceMutationVisibility: "shared-host" },
          },
          workspaceDir: workerWorkspaceDir,
          agentWorkspaceDir: workerWorkspaceDir,
          workspaceAccess: "ro",
          containerWorkdir: "/workspace",
          docker: { binds: [] },
        };
      }
      return {
        backendId: "docker",
        runtimeId: "requester-rw",
        backend: {
          configLabel: "openclaw-sandbox:latest",
          capabilities: { workspaceMutationVisibility: "shared-host" },
        },
        workspaceDir: workspaceDirOverride,
        agentWorkspaceDir: workspaceDirOverride,
        workspaceAccess: "rw",
        containerWorkdir: "/workspace",
        docker: { binds: [`${bindRoot}:/mnt/shared:rw`] },
        fsBridge: bridge,
      };
    });
    const registerSubagentRunMock = vi.fn();
    const childIngressCalls: string[] = [];
    const childIngressRoot = "/tmp/openclaw-attachment-ingress/worker";
    const childIngressBridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        relativePath: "",
        containerPath: filePath,
      }),
      mkdirp: async ({ filePath }: { filePath: string }) => {
        childIngressCalls.push(`mkdir:${filePath}`);
      },
      createFileExclusive: async ({ filePath }: { filePath: string }) => {
        childIngressCalls.push(`create:${filePath}`);
        return "created" as const;
      },
      remove: async () => undefined,
    };
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext,
      getSandboxBackendManager: () => ({
        prepareAttachmentIngress: async () => ({
          workspaceDir: workerWorkspaceDir,
          sandboxAttachmentsRootDir: `${childIngressRoot}/.openclaw/attachments`,
          sandboxFsBridge: childIngressBridge,
          cleanupLocator: { runtime: "worker-ro" },
          cleanupContainerWorkspaceDir: childIngressRoot,
        }),
        createFsCleanupBridge: async () => childIngressBridge,
      }),
      registerSubagentRunMock,
    });

    try {
      const result = await sandboxedSpawnModule.spawnSubagentDirect(
        {
          task: "test",
          agentId: "worker",
          attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
        },
        ctx,
      );

      expect(result.status).toBe("accepted");
      expect(bridgeCalls).toHaveLength(0);
      expect(childIngressCalls.some((call) => call.startsWith(`mkdir:${childIngressRoot}`))).toBe(
        true,
      );
      expect(registerSubagentRunMock).toHaveBeenCalledWith(
        expect.objectContaining({
          attachmentsSandboxSessionKey: expect.stringContaining("subagent"),
          attachmentsSandboxAgentId: "worker",
          attachmentsSandboxWorkspaceDir: workerWorkspaceDir,
          attachmentsSandboxIdentity: expect.objectContaining({ backendId: "docker" }),
        }),
      );
    } finally {
      fs.rmSync(bindRoot, { recursive: true, force: true });
    }
  });

  it("uses child ingress inside a read-only shadow of a writable bind", async () => {
    const bindRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-bind-shadow-${process.pid}-${Date.now()}-`),
    );
    const readOnlyRoot = path.join(bindRoot, "readonly");
    const workerWorkspaceDir = path.join(readOnlyRoot, "worker");
    fs.mkdirSync(readOnlyRoot);
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            workspaceAccess: "rw",
            docker: {
              binds: [`${bindRoot}:/mnt/shared:rw`, `${readOnlyRoot}:/mnt/shared/readonly:ro`],
            },
          },
        },
        list: [
          {
            id: "main",
            workspace: workspaceDirOverride,
            subagents: { allowAgents: ["worker"] },
          },
          { id: "worker", workspace: workerWorkspaceDir },
        ],
      },
    });
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        hostPath: filePath,
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
        await fs.promises.writeFile(filePath, data, { flag: "wx", mode: 0o600 });
        return "created" as const;
      },
      remove: async ({ filePath }: { filePath: string }) => {
        await fs.promises.rm(filePath, { recursive: true, force: true });
      },
    };
    const resolveSandboxContext = vi.fn(async () => runtimeLocalSandbox(bridge));
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext,
    });

    try {
      const result = await sandboxedSpawnModule.spawnSubagentDirect(
        {
          task: "test",
          agentId: "worker",
          attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
        },
        ctx,
      );

      expect(result.status).toBe("accepted");
      expect(resolveSandboxContext).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "worker", workspaceDir: workerWorkspaceDir }),
      );
      expect(fs.existsSync(path.join(workerWorkspaceDir, ".openclaw", "attachments"))).toBe(true);
    } finally {
      fs.rmSync(bindRoot, { recursive: true, force: true });
    }
  });

  it.each(["ro", "none"] as const)(
    "uses child ingress when primary workspace access is %s",
    async (workspaceAccess) => {
      const bindRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), `openclaw-subagent-bind-access-${process.pid}-${Date.now()}-`),
      );
      const workerWorkspaceDir = path.join(bindRoot, "worker");
      configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              workspaceAccess,
              docker: { binds: [`${bindRoot}:/mnt/shared:rw`] },
            },
          },
          list: [
            {
              id: "main",
              workspace: workspaceDirOverride,
              subagents: { allowAgents: ["worker"] },
            },
            { id: "worker", workspace: workerWorkspaceDir },
          ],
        },
      });
      const bridgeCalls: string[] = [];
      const bridge = {
        resolvePath: ({ filePath }: { filePath: string }) => ({
          hostPath: filePath,
          relativePath: "",
          containerPath: filePath,
        }),
        mkdirp: async ({ filePath }: { filePath: string }) => {
          bridgeCalls.push(`mkdir:${filePath}`);
          await fs.promises.mkdir(filePath, { recursive: true, mode: 0o700 });
        },
        createFileExclusive: async ({
          filePath,
          data,
        }: {
          filePath: string;
          data: Buffer | string;
        }) => {
          bridgeCalls.push(`create:${filePath}`);
          await fs.promises.writeFile(filePath, data, { flag: "wx", mode: 0o600 });
          return "created" as const;
        },
        remove: async ({ filePath }: { filePath: string }) => {
          await fs.promises.rm(filePath, { recursive: true, force: true });
        },
      };
      const resolveSandboxContext = vi.fn(async () => runtimeLocalSandbox(bridge));
      const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
        callGatewayMock,
        getRuntimeConfig: () => configOverride,
        updateSessionStoreMock,
        workspaceDir: workspaceDirOverride,
        resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
        resolveSandboxContext,
      });

      try {
        const result = await sandboxedSpawnModule.spawnSubagentDirect(
          {
            task: "test",
            agentId: "worker",
            attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
          },
          ctx,
        );

        expect(result.status).toBe("accepted");
        expect(resolveSandboxContext).toHaveBeenCalled();
        expect(bridgeCalls.some((call) => call.startsWith(`mkdir:${workerWorkspaceDir}`))).toBe(
          true,
        );
      } finally {
        fs.rmSync(bindRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "re-addresses a new canonical target through a symlinked requester workspace",
    async () => {
      const workspaceTarget = workspaceDirOverride;
      const workspaceAlias = `${workspaceTarget}-requester-link`;
      const workerWorkspaceDir = path.join(workspaceTarget, "worker-new");
      fs.symlinkSync(workspaceTarget, workspaceAlias, "dir");
      configOverride = createSubagentSpawnTestConfig(workspaceAlias, {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } },
          list: [
            {
              id: "main",
              workspace: workspaceAlias,
              subagents: { allowAgents: ["worker"] },
            },
            { id: "worker", workspace: workerWorkspaceDir },
          ],
        },
      });
      const resolvePath = vi.fn(({ filePath }: { filePath: string }) => ({
        hostPath: filePath,
        relativePath: "",
        containerPath: filePath,
      }));
      const bridge = {
        resolvePath,
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
          await fs.promises.writeFile(filePath, data, { flag: "wx", mode: 0o600 });
          return "created" as const;
        },
        remove: async ({ filePath }: { filePath: string }) => {
          await fs.promises.rm(filePath, { recursive: true, force: true });
        },
      };
      const resolveSandboxContext = vi.fn(async () => runtimeLocalSandbox(bridge));
      const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
        callGatewayMock,
        getRuntimeConfig: () => configOverride,
        updateSessionStoreMock,
        workspaceDir: workspaceAlias,
        resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
        resolveSandboxContext,
      });

      try {
        const result = await sandboxedSpawnModule.spawnSubagentDirect(
          {
            task: "test",
            agentId: "worker",
            attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
          },
          ctx,
        );

        expect(result.status).toBe("accepted");
        expect(resolveSandboxContext).toHaveBeenCalledWith(
          expect.objectContaining({ agentId: "worker", workspaceDir: workerWorkspaceDir }),
        );
        expect(resolvePath).toHaveBeenCalledWith({
          filePath: path.join(workerWorkspaceDir, ".openclaw", "attachments"),
        });
        expect(fs.existsSync(workerWorkspaceDir)).toBe(true);
      } finally {
        fs.rmSync(workerWorkspaceDir, { recursive: true, force: true });
        fs.unlinkSync(workspaceAlias);
      }
    },
  );

  it("uses backend-private ingress for a shared read-only sandbox", async () => {
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: {
        defaults: {
          workspace: workspaceDirOverride,
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
      },
    });
    const privateIngressRoot = "/private-ingress";
    const privateIngressHostRoot = path.join(workspaceDirOverride, "private-ingress");
    const toHostPath = (filePath: string) =>
      path.join(privateIngressHostRoot, path.posix.relative(privateIngressRoot, filePath));
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        hostPath: toHostPath(filePath),
        relativePath: path.posix.relative(privateIngressRoot, filePath),
        containerPath: filePath,
      }),
      mkdirp: async ({ filePath }: { filePath: string }) => {
        await fs.promises.mkdir(toHostPath(filePath), { recursive: true, mode: 0o700 });
      },
      createFileExclusive: async ({
        filePath,
        data,
      }: {
        filePath: string;
        data: Buffer | string;
      }) => {
        await fs.promises.writeFile(toHostPath(filePath), data, { flag: "wx", mode: 0o600 });
        return "created" as const;
      },
      remove: async ({ filePath }: { filePath: string }) => {
        await fs.promises.rm(toHostPath(filePath), { recursive: true, force: true });
      },
    };
    const createIngress = vi.fn(() => {
      throw new Error("shared-host staging must use backend-owned private ingress");
    });
    const childGatewayMock = vi.fn(async (request: unknown) => {
      const gatewayRequest = request as { method?: string; params?: { idempotencyKey?: unknown } };
      if (gatewayRequest.method === "agent") {
        expect(fs.existsSync(path.join(privateIngressHostRoot, ".openclaw", "attachments"))).toBe(
          true,
        );
        return { runId: gatewayRequest.params?.idempotencyKey };
      }
      return { ok: true };
    });
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock: childGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        backendId: "docker",
        runtimeId: "sandbox-readonly",
        backend: {
          configLabel: "openclaw-sandbox:latest",
          capabilities: { workspaceMutationVisibility: "shared-host" },
        },
        workspaceDir: workspaceDirOverride,
        agentWorkspaceDir: workspaceDirOverride,
        workspaceAccess: "ro",
        containerWorkdir: "/workspace",
        docker: { binds: [] },
      }),
      createSandboxWorkspaceIngressFsBridge: createIngress,
      getSandboxBackendManager: () => ({
        prepareAttachmentIngress: async () => ({
          workspaceDir: workspaceDirOverride,
          sandboxAttachmentsRootDir: `${privateIngressRoot}/.openclaw/attachments`,
          sandboxFsBridge: bridge,
          cleanupLocator: { runtime: "sandbox-readonly" },
          cleanupContainerWorkspaceDir: privateIngressRoot,
        }),
        createFsCleanupBridge: async () => bridge,
      }),
    });

    const result = await sandboxedSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result.status).toBe("accepted");
    expect(createIngress).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(privateIngressHostRoot, ".openclaw", "attachments"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDirOverride, ".openclaw", "attachments"))).toBe(false);
  });

  it("uses child-private ingress when a read-only alias masks a writable workspace", async () => {
    const attachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: {
        defaults: {
          workspace: workspaceDirOverride,
          sandbox: {
            mode: "all",
            workspaceAccess: "rw",
            docker: { binds: [`${attachmentsRoot}:/inspect:ro`] },
          },
        },
      },
    });
    const bridgeCalls: string[] = [];
    const privateIngressRoot = "/attachment-ingress";
    const privateIngressHostRoot = path.join(workspaceDirOverride, "private-ingress");
    const toHostPath = (filePath: string) =>
      filePath.startsWith(privateIngressRoot)
        ? path.join(privateIngressHostRoot, path.posix.relative(privateIngressRoot, filePath))
        : filePath.startsWith("/workspace")
          ? path.join(workspaceDirOverride, path.relative("/workspace", filePath))
          : filePath;
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        hostPath: toHostPath(filePath),
        relativePath: path.posix.relative("/workspace", filePath),
        containerPath: filePath,
      }),
      mkdirp: async ({ filePath }: { filePath: string }) => {
        bridgeCalls.push("mkdir");
        await fs.promises.mkdir(toHostPath(filePath), { recursive: true, mode: 0o700 });
      },
      createFileExclusive: async ({
        filePath,
        data,
      }: {
        filePath: string;
        data: Buffer | string;
      }) => {
        bridgeCalls.push(`create:${path.basename(filePath)}`);
        await fs.promises.writeFile(toHostPath(filePath), data, { flag: "wx", mode: 0o600 });
        return "created" as const;
      },
      remove: async ({ filePath }: { filePath: string }) => {
        await fs.promises.rm(toHostPath(filePath), { recursive: true, force: true });
      },
    };
    const registerSubagentRunMock = vi.fn();
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        backendId: "docker",
        runtimeId: "sandbox-rw",
        backend: {
          configLabel: "openclaw-sandbox:latest",
          capabilities: { workspaceMutationVisibility: "shared-host" },
        },
        workspaceDir: workspaceDirOverride,
        agentWorkspaceDir: workspaceDirOverride,
        workspaceAccess: "rw",
        containerWorkdir: "/workspace",
        docker: { binds: [`${attachmentsRoot}:/inspect:ro`] },
        fsBridge: bridge,
      }),
      createSandboxWorkspaceIngressFsBridge: () => {
        throw new Error("shared-host staging must use backend-owned private ingress");
      },
      getSandboxBackendManager: () => ({
        prepareAttachmentIngress: async () => ({
          workspaceDir: workspaceDirOverride,
          sandboxAttachmentsRootDir: `${privateIngressRoot}/.openclaw/attachments`,
          sandboxFsBridge: bridge,
          cleanupLocator: { runtime: "sandbox-rw" },
          cleanupContainerWorkspaceDir: privateIngressRoot,
        }),
        createFsCleanupBridge: async () => bridge,
      }),
      registerSubagentRunMock,
    });

    const result = await sandboxedSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "SKILL.md", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result.status).toBe("accepted");
    expect(bridgeCalls).toContain("mkdir");
    expect(bridgeCalls).toContain("create:SKILL.md");
    expect(registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentsSandboxIdentity: {
          backendId: "docker",
          runtimeId: "sandbox-rw",
          fsCleanupLocator: { runtime: "sandbox-rw" },
        },
        attachmentsSandboxDir: expect.stringContaining(
          "/attachment-ingress/.openclaw/attachments/",
        ),
      }),
    );
  });

  it.runIf(process.platform !== "win32").each(["metadata", "attachments"] as const)(
    "rejects a symlinked %s directory inside the private ingress",
    async (linkedComponent) => {
      const externalDir = fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          `openclaw-subagent-attachment-external-${process.pid}-${Date.now()}-`,
        ),
      );
      fs.writeFileSync(path.join(externalDir, "sentinel.txt"), "unchanged", "utf8");
      try {
        const store: Record<string, Record<string, unknown>> = {};
        updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
          if (typeof mutator !== "function") {
            throw new Error("missing session store mutator");
          }
          await mutator(store);
          const childSessionKey = Object.keys(store).find((key) => key.includes(":subagent:"));
          if (childSessionKey) {
            const privateWorkspace = resolveSandboxAttachmentIngressWorkspace(childSessionKey);
            const metadataDir = path.join(privateWorkspace, ".openclaw");
            fs.mkdirSync(privateWorkspace, { recursive: true });
            if (linkedComponent === "metadata") {
              if (!fs.existsSync(metadataDir)) {
                fs.symlinkSync(externalDir, metadataDir, "dir");
              }
            } else if (!fs.existsSync(path.join(metadataDir, "attachments"))) {
              fs.mkdirSync(metadataDir, { recursive: true });
              fs.symlinkSync(externalDir, path.join(metadataDir, "attachments"), "dir");
            }
          }
          return store;
        });

        const result = await spawnWithName("file.txt");

        expect(result.status).toBe("error");
        expect(fs.readdirSync(externalDir)).toEqual(["sentinel.txt"]);
        expect(fs.readFileSync(path.join(externalDir, "sentinel.txt"), "utf8")).toBe("unchanged");
      } finally {
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps unsandboxed attachments outside a configured workspace symlink",
    async () => {
      const workspaceTarget = workspaceDirOverride;
      const workspaceAlias = `${workspaceTarget}-link`;
      fs.symlinkSync(workspaceTarget, workspaceAlias, "dir");
      workspaceDirOverride = workspaceAlias;
      configOverride = createSubagentSpawnTestConfig(workspaceAlias);
      try {
        const result = await spawnWithName("file.txt");

        expect(result.status).toBe("accepted");
        const privateAttachmentsRoot = path.join(
          resolveSandboxAttachmentIngressWorkspace(result.childSessionKey as string),
          ".openclaw",
          "attachments",
        );
        expect(fs.readdirSync(privateAttachmentsRoot)).toHaveLength(1);
        expect(fs.existsSync(path.join(workspaceTarget, ".openclaw"))).toBe(false);
      } finally {
        workspaceDirOverride = workspaceTarget;
        fs.unlinkSync(workspaceAlias);
      }
    },
  );

  it("normalizes explicit cwd while keeping native attachments in private ingress", async () => {
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `openclaw-subagent-home-attachments-${process.pid}-${Date.now()}-`),
    );
    const expectedCwd = path.join(homeDir, "task-repo");
    let persistedStore: Record<string, Record<string, unknown>> | undefined;
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      persistedStore = store;
      return store;
    });
    try {
      await withEnvAsync({ HOME: homeDir }, async () => {
        const { spawnSubagentDirect } = subagentSpawnModule;
        const result = await spawnSubagentDirect(
          {
            task: "test",
            cwd: "~/task-repo",
            attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
          },
          ctx,
        );

        expect(result.status).toBe("accepted");
        const childSessionKey = result.childSessionKey as string;
        const attachmentsRoot = path.join(
          resolveSandboxAttachmentIngressWorkspace(childSessionKey),
          ".openclaw",
          "attachments",
        );
        expect(fs.existsSync(attachmentsRoot)).toBe(true);
        expect(fs.existsSync(path.join(expectedCwd, ".openclaw"))).toBe(false);
        expect(persistedStore?.[childSessionKey]?.spawnedCwd).toBe(expectedCwd);
      });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
