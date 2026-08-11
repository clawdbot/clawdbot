import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimePluginIdScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  getRuntimeConfig: vi.fn(() => ({}) as OpenClawConfig),
  prepareAgentRunAdmission: vi.fn(),
  runEmbeddedAgentCore: vi.fn(),
}));

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.getRuntimeConfig }));

import { runPluginEmbeddedAgent } from "./runtime-embedded-agent.runtime.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const config = {} as OpenClawConfig;
const params = {
  config,
  prompt: "check",
  runId: "run-plugin",
  sessionId: "session-plugin",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-plugin",
    sessionKey: "agent:researcher:plugin",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

describe("plugin embedded-agent runtime admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareAgentRunAdmission.mockReturnValue({
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      admit: vi.fn(),
      close: mocks.close,
    });
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
  });

  it("binds plugin facts and closes the exact prepared admission after success", async () => {
    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () => runPluginEmbeddedAgent(params)),
    ).resolves.toEqual({ payloads: [] });

    expect(mocks.prepareAgentRunAdmission).toHaveBeenCalledWith({
      cfg: config,
      operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
      facts: {
        runId: "run-plugin",
        agentId: "researcher",
        ingress: {
          kind: "plugin",
          boundary: "plugin-runtime",
          rawSourceRef: "memory-plugin",
          state: "present",
        },
      },
    });
    expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({
        ...params,
        preparedRunAdmission: expect.objectContaining({ close: mocks.close }),
      }),
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes the prepared admission when core execution throws", async () => {
    mocks.runEmbeddedAgentCore.mockRejectedValueOnce(new Error("core failed"));

    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () => runPluginEmbeddedAgent(params)),
    ).rejects.toThrow("core failed");
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("revokes admission immediately when a pending plugin run aborts", async () => {
    const core = deferred<{ payloads: never[] }>();
    mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    const controller = new AbortController();
    const run = withPluginRuntimePluginIdScope("memory-plugin", () =>
      runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
    );
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());

    controller.abort(new Error("cancelled"));
    expect(mocks.close).toHaveBeenCalledOnce();
    core.resolve({ payloads: [] });
    await expect(run).resolves.toEqual({ payloads: [] });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes admission when abort races with listener registration", async () => {
    const controller = new AbortController();
    mocks.prepareAgentRunAdmission.mockImplementationOnce(() => {
      controller.abort(new Error("raced cancellation"));
      return {
        operationalRunInstance: { instanceId: "instance:run-plugin", runId: "run-plugin" },
        admit: vi.fn(),
        close: mocks.close,
      };
    });

    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow("raced cancellation");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("does not create admission for an already-aborted plugin run", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));

    await expect(
      withPluginRuntimePluginIdScope("memory-plugin", () =>
        runPluginEmbeddedAgent({ ...params, abortSignal: controller.signal }),
      ),
    ).rejects.toThrow("already cancelled");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it("fails closed outside a plugin scope", async () => {
    await expect(runPluginEmbeddedAgent(params)).rejects.toThrow("active plugin runtime scope");
    expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
    expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
  });

  it.each(["admittedRunContext", "preparedRunAdmission"] as const)(
    "rejects a plugin-supplied %s",
    async (field) => {
      await expect(
        withPluginRuntimePluginIdScope("memory-plugin", () =>
          runPluginEmbeddedAgent({ ...params, [field]: {} } as never),
        ),
      ).rejects.toThrow("cannot supply host run authority");
      expect(mocks.prepareAgentRunAdmission).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgentCore).not.toHaveBeenCalled();
    },
  );
});
