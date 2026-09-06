import { describe, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { resolveGatewayLifecycleContext } from "./lifecycle-context.js";

const readGatewayServiceCommandForMutation = vi.hoisted(() => vi.fn());

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceCommandForMutation,
}));

describe("resolveGatewayLifecycleContext", () => {
  it("uses a relocated definition for strict update lifecycle context", async () => {
    const command = {
      programArguments: ["node", "openclaw", "gateway", "--port", "19876"],
      environment: { OPENCLAW_STATE_DIR: "/external/state" },
    };
    const service = createMockGatewayService({ readCommand: vi.fn(async () => null) });
    readGatewayServiceCommandForMutation.mockResolvedValue({
      kind: "relocated",
      plistPath: "/external/Library/LaunchAgents/ai.openclaw.gateway.plist",
      command,
    });

    await expect(resolveGatewayLifecycleContext(service, true)).resolves.toMatchObject({
      port: 19876,
      command,
      env: { OPENCLAW_STATE_DIR: "/external/state" },
    });
  });

  it("keeps ordinary lifecycle reads canonical-only", async () => {
    readGatewayServiceCommandForMutation.mockClear();
    const command = {
      programArguments: ["node", "openclaw", "gateway", "--port", "18790"],
    };
    const service = createMockGatewayService({ readCommand: vi.fn(async () => command) });

    await expect(resolveGatewayLifecycleContext(service)).resolves.toMatchObject({
      port: 18790,
      command,
    });
    expect(readGatewayServiceCommandForMutation).not.toHaveBeenCalled();
  });
});
