// Subagent spawn attachment tests cover strict base64 decoding, attachment name
// validation, materialization paths, and cleanup after spawn failures.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../../test-utils/env.js";
import { reserveChildAdmissionSlot } from "../../child-admission.js";
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
    backend: { configLabel: "worker@example.test" },
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

  it.each([
    ["empty", ""],
    ["bad padding", "abc"],
    ["invalid characters", "!@#$"],
    ["whitespace only", "   "],
    ["pre-decode oversize", "A".repeat(2737)],
    ["decoded oversize", Buffer.alloc(1025, 0x42).toString("base64")],
  ])("rejects %s base64 attachments through the spawn boundary", async (_label, content) => {
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      tools: {
        sessions_spawn: {
          attachments: {
            enabled: true,
            maxFiles: 50,
            maxFileBytes: 1024,
            maxTotalBytes: 5 * 1024 * 1024,
          },
        },
      },
    });
    const result = await subagentSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.bin", content, encoding: "base64" }],
      },
      ctx,
    );
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining("attachments_invalid_base64_or_too_large"),
    });
  });

  it("name with / returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo/bar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '..' returns attachments_invalid_name", async () => {
    const result = await spawnWithName("..");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name '.manifest.json' returns attachments_invalid_name", async () => {
    const result = await spawnWithName(".manifest.json");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("name with newline returns attachments_invalid_name", async () => {
    const result = await spawnWithName("foo\nbar");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("duplicate name returns attachments_duplicate_name", async () => {
    const { spawnSubagentDirect } = subagentSpawnModule;
    const result = await spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "file.txt", content: validContent, encoding: "base64" },
          { name: "file.txt", content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_duplicate_name/);
  });

  it("empty name returns attachments_invalid_name", async () => {
    const result = await spawnWithName("");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/attachments_invalid_name/);
  });

  it("materializes attachments under explicit cwd when native subagent cwd is provided", async () => {
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
      const explicitAttachmentsRoot = path.join(explicitWorkspaceDir, ".openclaw", "attachments");
      const targetAttachmentsRoot = path.join(workspaceDirOverride, ".openclaw", "attachments");
      expect(fs.existsSync(explicitAttachmentsRoot)).toBe(true);
      expect(fs.existsSync(targetAttachmentsRoot)).toBe(false);
      if (process.platform !== "win32") {
        const [receiptDir] = fs.readdirSync(explicitAttachmentsRoot);
        expect(receiptDir).toBeTypeOf("string");
        if (!receiptDir) {
          throw new Error("missing attachment receipt directory");
        }
        for (const privateDir of [
          path.join(explicitWorkspaceDir, ".openclaw"),
          explicitAttachmentsRoot,
          path.join(explicitAttachmentsRoot, receiptDir),
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
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => runtimeLocalSandbox(bridge),
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
    expect(fs.existsSync(path.join(workspaceDirOverride, ".openclaw", "attachments"))).toBe(true);
    expect(registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentsSandboxSessionKey: expect.stringContaining(":subagent:"),
        attachmentsSandboxAgentId: "main",
        attachmentsSandboxWorkspaceDir: workspaceDirOverride,
        attachmentsSandboxIdentity: {
          backendId: "ssh",
          runtimeId: "runtime-main",
          configLabel: "worker@example.test",
        },
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

  it("uses the requester bridge for a writable bind with a read-only shadow", async () => {
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
            docker: {
              binds: [
                `${bindRoot}:/mnt/shared:rw`,
                `${path.join(bindRoot, "readonly")}:/mnt/shared/readonly:ro`,
              ],
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
    const bridgeCalls: string[] = [];
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => {
        bridgeCalls.push(`resolve:${filePath}`);
        return { hostPath: filePath, relativePath: "", containerPath: filePath };
      },
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
      expect(bridgeCalls.some((call) => call === `resolve:${workerWorkspaceDir}`)).toBe(true);
      expect(bridgeCalls.some((call) => call.startsWith(`mkdir:${workerWorkspaceDir}`))).toBe(true);
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
        expect(resolvePath).toHaveBeenCalledWith({ filePath: workerWorkspaceDir });
        expect(fs.existsSync(workerWorkspaceDir)).toBe(true);
      } finally {
        fs.rmSync(workerWorkspaceDir, { recursive: true, force: true });
        fs.unlinkSync(workspaceAlias);
      }
    },
  );

  it("stages into the host copy behind a shared read-only sandbox mount", async () => {
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: {
        defaults: {
          workspace: workspaceDirOverride,
          sandbox: { mode: "all", workspaceAccess: "ro" },
        },
      },
    });
    const sandboxWorkspaceDir = path.join(workspaceDirOverride, "sandbox-copy");
    const createIngress = vi.fn(() => {
      throw new Error("shared host workspaces must not stage through a read-only container");
    });
    const childGatewayMock = vi.fn(async (request: unknown) => {
      if ((request as { method?: string }).method === "agent") {
        expect(fs.existsSync(path.join(sandboxWorkspaceDir, ".openclaw", "attachments"))).toBe(
          true,
        );
      }
      return { runId: "child-run" };
    });
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock: childGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        backend: { capabilities: { workspaceMutationVisibility: "shared-host" } },
        workspaceDir: sandboxWorkspaceDir,
        agentWorkspaceDir: workspaceDirOverride,
      }),
      createSandboxWorkspaceIngressFsBridge: createIngress,
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
    expect(fs.existsSync(path.join(sandboxWorkspaceDir, ".openclaw", "attachments"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDirOverride, ".openclaw", "attachments"))).toBe(false);
  });

  it("does not mutate the receipt path when the durable cleanup claim fails", async () => {
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } },
    });
    const mutations: string[] = [];
    const bridge = {
      resolvePath: ({ filePath }: { filePath: string }) => ({
        relativePath: "",
        containerPath: filePath,
      }),
      mkdirp: async () => {
        mutations.push("mkdir");
      },
      createFileExclusive: async () => {
        mutations.push("create");
        return "created" as const;
      },
      remove: async () => {
        mutations.push("remove");
      },
    };
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        ...runtimeLocalSandbox(bridge),
        workspaceDir: workspaceDirOverride,
        agentWorkspaceDir: workspaceDirOverride,
      }),
      registerSubagentRunMock: vi.fn(() => {
        throw new Error("state database unavailable");
      }),
    });

    const result = await sandboxedSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result).toMatchObject({ status: "error", error: "state database unavailable" });
    expect(mutations).toEqual([]);
    expect(callGatewayMock).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("retains the provisional owner when partial-write cleanup fails", async () => {
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride, {
      agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } },
    });
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
    const sandboxedSpawnModule = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        ...runtimeLocalSandbox(bridge),
        workspaceDir: workspaceDirOverride,
        agentWorkspaceDir: workspaceDirOverride,
      }),
      registerSubagentRunMock,
      settleFailedQueuedSubagentLaunchMock,
      releaseSubagentRunMock,
    });

    const result = await sandboxedSpawnModule.spawnSubagentDirect(
      {
        task: "test",
        attachments: [
          { name: "one.txt", content: validContent, encoding: "base64" },
          { name: "two.txt", content: validContent, encoding: "base64" },
        ],
      },
      ctx,
    );

    expect(result).toMatchObject({ status: "error", error: "second write failed" });
    expect(registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ queued: true, attachmentsDir: expect.any(String) }),
    );
    expect(settleFailedQueuedSubagentLaunchMock).toHaveBeenCalledTimes(1);
    expect(releaseSubagentRunMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32").each(["metadata", "attachments"] as const)(
    "rejects a symlinked %s directory without writing outside the workspace",
    async (linkedComponent) => {
      const externalDir = fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          `openclaw-subagent-attachment-external-${process.pid}-${Date.now()}-`,
        ),
      );
      fs.writeFileSync(path.join(externalDir, "sentinel.txt"), "unchanged", "utf8");
      try {
        const metadataDir = path.join(workspaceDirOverride, ".openclaw");
        if (linkedComponent === "metadata") {
          fs.symlinkSync(externalDir, metadataDir, "dir");
        } else {
          fs.mkdirSync(metadataDir, { recursive: true });
          fs.symlinkSync(externalDir, path.join(metadataDir, "attachments"), "dir");
        }

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
    "materializes attachments through a configured workspace symlink",
    async () => {
      const workspaceTarget = workspaceDirOverride;
      const workspaceAlias = `${workspaceTarget}-link`;
      fs.symlinkSync(workspaceTarget, workspaceAlias, "dir");
      workspaceDirOverride = workspaceAlias;
      configOverride = createSubagentSpawnTestConfig(workspaceAlias);
      try {
        const result = await spawnWithName("file.txt");

        expect(result.status).toBe("accepted");
        const attachmentsRoot = path.join(workspaceTarget, ".openclaw", "attachments");
        expect(fs.readdirSync(attachmentsRoot)).toHaveLength(1);
      } finally {
        workspaceDirOverride = workspaceTarget;
        fs.unlinkSync(workspaceAlias);
      }
    },
  );

  it("normalizes explicit cwd before materializing native subagent attachments", async () => {
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
        const attachmentsRoot = path.join(expectedCwd, ".openclaw", "attachments");
        expect(fs.existsSync(attachmentsRoot)).toBe(true);
        const childSessionKey = result.childSessionKey as string;
        expect(persistedStore?.[childSessionKey]?.spawnedCwd).toBe(expectedCwd);
      });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
