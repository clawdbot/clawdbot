import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAgentToolsSandboxContext } from "../../agents/test-helpers/agent-tools-sandbox-context.js";
import {
  createSilentIdleArgv,
  createStubChildAdapter,
  spawnChild,
} from "./supervisor.test-support.js";

const { createChildAdapterMock, createPtyAdapterMock, getProcessSupervisorMock } = vi.hoisted(
  () => ({
    createChildAdapterMock: vi.fn(),
    createPtyAdapterMock: vi.fn(),
    getProcessSupervisorMock: vi.fn(),
  }),
);

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

vi.mock("./adapters/pty.js", () => ({ createPtyAdapter: createPtyAdapterMock }));
vi.mock("../../agents/shell-snapshot.js", () => ({
  maybeWrapCommandWithShellSnapshot: async ({ command }: { command: string }) => command,
}));

vi.mock("./index.js", () => ({
  getProcessSupervisor: getProcessSupervisorMock,
}));

let runExecProcess: typeof import("../../agents/bash-tools.exec-runtime.js").runExecProcess;
let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;
let createOpenClawCodingTools: typeof import("../../agents/agent-tools.js").createOpenClawCodingTools;

function prepareOneShotTools(
  scopeKey: string,
  generationCleanups: Array<(reason: string) => Promise<void>>,
) {
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
  return generationCleanups[0]!;
}

describe("one-shot tool-generation process cleanup", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createProcessSupervisor } = await import("./supervisor.js"));
    ({ createOpenClawCodingTools } = await import("../../agents/agent-tools.js"));
    ({ runExecProcess } = await import("../../agents/bash-tools.exec-runtime.js"));
  });

  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
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
        const cleanup = prepareOneShotTools(scopeKey, generationCleanups);
        const externalRun = await supervisor.spawn({
          mode: "child",
          argv: createSilentIdleArgv(),
          scopeKey,
          cleanupOwnership: "external",
        });
        const hostRun = await spawnChild(supervisor, {
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

  it("runs a one-shot host PTY request once through the owned child fallback", async () => {
    const supervisor = createProcessSupervisor();
    getProcessSupervisorMock.mockReturnValue(supervisor);
    const scopeKey = "scope:pty-owned-fallback";
    const generationCleanups: Array<(reason: string) => Promise<void>> = [];
    const extinction = createDeferred();
    const child = Object.assign(createStubChildAdapter(), {
      waitForExtinction: () => extinction.promise,
    });
    const pty = createStubChildAdapter();
    pty.settle(0);
    createPtyAdapterMock.mockResolvedValue(pty);
    createChildAdapterMock.mockResolvedValue(child);
    const warnings: string[] = [];
    let run: Awaited<ReturnType<typeof runExecProcess>> | undefined;
    try {
      const cleanup = prepareOneShotTools(scopeKey, generationCleanups);
      run = await runExecProcess({
        command: "fixture-command",
        workdir: "/tmp",
        env: {},
        usePty: true,
        scopeKey,
        warnings,
        maxOutput: 1000,
        pendingMaxOutput: 1000,
        notifyOnExit: false,
        timeoutSec: null,
      });
      expect(createPtyAdapterMock).not.toHaveBeenCalled();
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
      expect(createChildAdapterMock.mock.calls[0]?.[0].ownProcessTree).toBe(true);
      expect(warnings).toEqual([
        expect.stringContaining("PTY is unavailable when execution requires process-tree cleanup"),
      ]);
      child.emitStdout("command ran once");
      child.settle(0);
      await expect(run.promise).resolves.toMatchObject({
        status: "completed",
        aggregated: "command ran once",
      });
      const closed = vi.fn();
      const closing = cleanup("completed");
      void closing.then(closed, closed);
      await Promise.resolve();
      expect(closed).not.toHaveBeenCalled();
      expect(child.killMock).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      extinction.resolve();
      await expect(closing).resolves.toBeUndefined();
    } finally {
      child.settle(0);
      extinction.resolve();
      await Promise.allSettled([
        run?.promise,
        ...generationCleanups.map((cleanup) => cleanup("test cleanup")),
        supervisor.shutdown(),
      ]);
    }
  });
});
