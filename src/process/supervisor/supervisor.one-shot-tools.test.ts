import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAgentToolsSandboxContext } from "../../agents/test-helpers/agent-tools-sandbox-context.js";
import {
  createSilentIdleArgv,
  createStubChildAdapter,
  spawnChild,
} from "./supervisor.test-support.js";

const { createChildAdapterMock, getProcessSupervisorMock } = vi.hoisted(() => ({
  createChildAdapterMock: vi.fn(),
  getProcessSupervisorMock: vi.fn(),
}));

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

vi.mock("./index.js", () => ({
  getProcessSupervisor: getProcessSupervisorMock,
}));

let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;
let createOpenClawCodingTools: typeof import("../../agents/agent-tools.js").createOpenClawCodingTools;

describe("one-shot tool-generation process cleanup", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createProcessSupervisor } = await import("./supervisor.js"));
    ({ createOpenClawCodingTools } = await import("../../agents/agent-tools.js"));
  });

  beforeEach(() => {
    createChildAdapterMock.mockReset();
    getProcessSupervisorMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "joins one-shot tool-generation backend and host cleanup (hostFails=%s)",
    async (hostFails) => {
      const supervisor = createProcessSupervisor();
      getProcessSupervisorMock.mockReturnValue(supervisor);
      const scopeKey = "scope:mixed-owned-lifetimes";
      const generationCleanups: Array<(reason: string) => Promise<void>> = [];
      const external = createStubChildAdapter();
      const extinction = createDeferred();
      const host = Object.assign(createStubChildAdapter(), {
        waitForExtinction: () => extinction.promise,
      });
      createChildAdapterMock.mockResolvedValueOnce(external).mockResolvedValueOnce(host);
      try {
        createOpenClawCodingTools({
          config: { plugins: { enabled: false } },
          sessionKey: scopeKey,
          workspaceDir: "/workspace",
          cwd: "/workspace",
          sandbox: createAgentToolsSandboxContext({ workspaceDir: "/workspace" }),
          oneShotCliRun: true,
          registerRunCleanup: (cleanup) => {
            generationCleanups.push(cleanup);
          },
          toolConstructionPlan: {
            includeBaseCodingTools: false,
            includeShellTools: false,
            includeChannelTools: false,
            includeOpenClawTools: false,
            includePluginTools: false,
          },
        });
        expect(generationCleanups).toHaveLength(1);
        const cleanup = generationCleanups[0]!;
        const externalRun = await supervisor.spawn({
          mode: "child",
          argv: createSilentIdleArgv(),
          sessionId: scopeKey,
          scopeKey,
          backendId: "sandbox-transport",
          cleanupOwnership: "external",
        });
        const hostRun = await spawnChild(supervisor, {
          sessionId: scopeKey,
          scopeKey,
          argv: createSilentIdleArgv(),
        });
        expect(createChildAdapterMock.mock.calls[0]?.[0].ownProcessTree).toBeUndefined();
        expect(createChildAdapterMock.mock.calls[1]?.[0].ownProcessTree).toBe(true);
        external.settle(0);
        host.settle(0);
        await Promise.all([externalRun.wait(), hostRun.wait()]);
        const joined = vi.fn();
        const closing = cleanup("completed");
        void closing.then(joined, joined);
        await Promise.resolve();
        expect(joined).not.toHaveBeenCalled();
        expect(host.killMock).toHaveBeenCalledExactlyOnceWith("SIGTERM");
        if (hostFails) {
          extinction.reject(new Error("owned host cleanup failed"));
          await expect(closing).rejects.toThrow("owned host cleanup failed");
          await expect(supervisor.shutdown()).rejects.toThrow("owned host cleanup failed");
        } else {
          extinction.resolve();
          await expect(closing).resolves.toBeUndefined();
          await expect(supervisor.shutdown()).resolves.toBeUndefined();
        }
      } finally {
        external.settle(0);
        host.settle(0);
        extinction.resolve();
        await Promise.allSettled([
          ...generationCleanups.map((cleanup) => cleanup("test cleanup")),
          supervisor.shutdown(),
        ]);
      }
    },
  );
});
