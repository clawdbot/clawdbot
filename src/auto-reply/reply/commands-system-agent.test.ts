import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayHostLifecycle } from "../../gateway/server-public.js";
import { runSystemAgentRescueMessage } from "../../system-agent/rescue-message.js";
import { handleSystemAgentCommand } from "./commands-system-agent.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";

const { resolveContext } = vi.hoisted(() => ({
  resolveContext: vi.fn<() => { hostLifecycle: GatewayHostLifecycle } | undefined>(),
}));
vi.mock("../../channels/message-access/admission-evidence.js", () => ({
  readChannelContextGatewayContextResolver: () => resolveContext,
}));
vi.mock("../../system-agent/rescue-message.js", () => ({
  extractSystemAgentRescueMessage: () => "yes",
  runSystemAgentRescueMessage: vi.fn(),
}));

describe("channel rescue lifecycle ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("marks rescue as hosted even without a capability, so it cannot fall through to CLI", async () => {
    const params = buildCommandTestParams("/openclaw yes", baseCommandTestConfig);
    await handleSystemAgentCommand(params, true);
    expect(runSystemAgentRescueMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        deps: { setupSurface: "gateway", gatewayHostLifecycle: undefined },
      }),
    );
  });

  it("retains the admitted host and rechecks invocation authority after awaited work", async () => {
    const original = vi.fn<GatewayHostLifecycle["request"]>(async (_action, guard) => {
      await Promise.resolve();
      guard();
      return { ok: true, value: { outcome: "scheduled" } };
    });
    const successor = vi.fn<GatewayHostLifecycle["request"]>();
    resolveContext.mockReturnValue({ hostLifecycle: { request: original } });
    const abort = new AbortController();
    const params = buildCommandTestParams("/openclaw yes", baseCommandTestConfig);
    params.commandInvocationSignal = abort.signal;
    vi.mocked(runSystemAgentRescueMessage).mockImplementationOnce(async (input) => {
      resolveContext.mockReturnValue({ hostLifecycle: { request: successor } });
      abort.abort(new Error("request retired"));
      await input.deps!.gatewayHostLifecycle!.request("stop", () => {});
      return "scheduled";
    });
    await expect(handleSystemAgentCommand(params, true)).rejects.toThrow("request retired");
    expect(original).toHaveBeenCalledOnce();
    expect(successor).not.toHaveBeenCalled();
  });
});
