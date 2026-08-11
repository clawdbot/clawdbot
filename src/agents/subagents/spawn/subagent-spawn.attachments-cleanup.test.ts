// Attachment cleanup tests cover durable failed-launch ownership and bounded
// accepted-run termination across session replacement and gateway outages.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../../config/sessions/lifecycle.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

describe("spawnSubagentDirect attachment cleanup ownership", () => {
  const updateSessionStoreMock = vi.fn();
  const ctx = {
    agentSessionKey: "agent:main:main",
    agentChannel: "forum" as const,
    agentAccountId: "123",
    agentTo: "456",
  };
  const validContent = Buffer.from("hello").toString("base64");
  let workspaceDirOverride = "";
  let configOverride = createSubagentSpawnTestConfig();

  beforeEach(() => {
    workspaceDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-attachment-cleanup-"));
    configOverride = createSubagentSpawnTestConfig(workspaceDirOverride);
    const store: Record<string, Record<string, unknown>> = {};
    updateSessionStoreMock.mockReset();
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      await mutator(store);
      return store;
    });
    resetGatewayWorkAdmission();
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
    fs.rmSync(workspaceDirOverride, { recursive: true, force: true });
  });

  const runtimeLocalSandbox = (fsBridge: unknown) => ({
    backendId: "ssh",
    runtimeId: "runtime-main",
    backend: { configLabel: "worker@example.test" },
    fsBridge,
  });

  it("retains the provisional owner when its frozen session was replaced", async () => {
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
      remove: async ({ filePath }: { filePath: string }) => {
        await fs.promises.rm(filePath, { recursive: true, force: true });
      },
    };
    const lifecycleChanged = Object.assign(new Error("session changed"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
      details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
    });
    const gateway = vi.fn(async (request: unknown) => {
      if ((request as { method?: string }).method === "sessions.delete") {
        throw lifecycleChanged;
      }
      return { ok: true };
    });
    const releaseSubagentRunMock = vi.fn(async () => undefined);
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock: gateway,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      resolveSandboxRuntimeStatus: () => ({ sandboxed: true, agentId: "main" }) as never,
      resolveSandboxContext: async () => ({
        ...runtimeLocalSandbox(bridge),
        workspaceDir: workspaceDirOverride,
        agentWorkspaceDir: workspaceDirOverride,
      }),
      settleFailedQueuedSubagentLaunchMock: vi.fn(() => true),
      releaseSubagentRunMock,
    });

    const result = await module.spawnSubagentDirect(
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
    expect(releaseSubagentRunMock).not.toHaveBeenCalled();
  });

  it("aborts an accepted child before cleaning a failed attachment-owner activation", async () => {
    const events: string[] = [];
    const gateway = vi.fn(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent") {
        events.push("accepted");
        return { runId: "accepted-child-run" };
      }
      if (method === "chat.abort") {
        events.push("aborted");
        return { aborted: true, runIds: ["accepted-child-run"] };
      }
      return { ok: true };
    });
    const settleFailedQueuedSubagentLaunchMock = vi.fn(() => {
      events.push("terminalized");
      return true;
    });
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock: gateway,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      startQueuedSubagentRunMock: vi.fn(() => {
        throw new Error("activation persistence failed");
      }),
      settleFailedQueuedSubagentLaunchMock,
    });

    const result = await module.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result).toMatchObject({ status: "error", runId: "accepted-child-run" });
    expect(events).toEqual(["accepted", "aborted", "terminalized"]);
  });

  it("terminalizes the owner when accepted-child termination needs a later retry", async () => {
    const events: string[] = [];
    let abortAttempts = 0;
    const gateway = vi.fn(async (request: unknown) => {
      const method = (request as { method?: string }).method;
      if (method === "agent") {
        events.push("accepted");
        return { runId: "accepted-child-run" };
      }
      if (method === "chat.abort") {
        abortAttempts += 1;
        if (abortAttempts > 1) {
          events.push("aborted");
          return { aborted: true, runIds: ["accepted-child-run"] };
        }
        events.push("abort-failed");
        throw new Error("abort unavailable");
      }
      if (method === "sessions.delete") {
        events.push("delete-failed");
        throw new Error("delete unavailable");
      }
      return { ok: true };
    });
    const settleFailedQueuedSubagentLaunchMock = vi.fn(() => {
      events.push("terminalized");
      return true;
    });
    const releaseSubagentRunMock = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => {
      events.push("rollback");
    });
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock: gateway,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      startQueuedSubagentRunMock: vi.fn(() => {
        throw new Error("activation persistence failed");
      }),
      settleFailedQueuedSubagentLaunchMock,
      releaseSubagentRunMock,
      resolveContextEngineMock: async () => ({
        prepareSubagentSpawn: async () => ({ rollback }),
      }),
      completeFailedLaunchContextEngineCleanupMock: vi.fn(() => {
        events.push("rollback-recorded");
      }),
      scheduleSubagentRegistrySweepMock: vi.fn(() => {
        events.push("sweep-scheduled");
      }),
    });

    const result = await module.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result).toMatchObject({ status: "error", runId: "accepted-child-run" });
    expect(releaseSubagentRunMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(events).toEqual(
        expect.arrayContaining([
          "terminalized",
          "aborted",
          "rollback",
          "rollback-recorded",
          "sweep-scheduled",
        ]),
      );
    });
    expect(events.slice(0, 3)).toEqual(["accepted", "abort-failed", "delete-failed"]);
    expect(events.indexOf("rollback")).toBeGreaterThan(events.indexOf("aborted"));
    expect(events.indexOf("rollback-recorded")).toBeGreaterThan(events.indexOf("rollback"));
    expect(events.indexOf("sweep-scheduled")).toBeGreaterThan(
      events.indexOf("rollback-recorded"),
    );
  });

  it("releases detached root work after a bounded accepted-child cleanup retry", async () => {
    const gateway = vi.fn(async (request: unknown) => {
      if ((request as { method?: string }).method === "agent") {
        return { runId: "accepted-child-run" };
      }
      throw new Error("gateway unavailable");
    });
    const rollback = vi.fn(async () => undefined);
    const scheduleSweep = vi.fn();
    const module = await loadSubagentSpawnModuleForTest({
      callGatewayMock: gateway,
      getRuntimeConfig: () => configOverride,
      updateSessionStoreMock,
      workspaceDir: workspaceDirOverride,
      startQueuedSubagentRunMock: vi.fn(() => {
        throw new Error("activation persistence failed");
      }),
      settleFailedQueuedSubagentLaunchMock: vi.fn(() => true),
      resolveContextEngineMock: async () => ({
        prepareSubagentSpawn: async () => ({ rollback }),
      }),
      scheduleSubagentRegistrySweepMock: scheduleSweep,
    });

    const result = await module.spawnSubagentDirect(
      {
        task: "test",
        attachments: [{ name: "file.txt", content: validContent, encoding: "base64" }],
      },
      ctx,
    );

    expect(result).toMatchObject({ status: "error", runId: "accepted-child-run" });
    await vi.waitFor(() => {
      expect(scheduleSweep).toHaveBeenCalledWith({ delayMs: 0 });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
    expect(rollback).not.toHaveBeenCalled();
    expect(
      gateway.mock.calls.filter(
        ([request]) => (request as { method?: string }).method === "chat.abort",
      ),
    ).toHaveLength(2);
  });
});
