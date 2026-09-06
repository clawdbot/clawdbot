import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activateRuntime: vi.fn(async () => {
    throw new Error("read-only inspection activated the runtime");
  }),
  staticStatus: vi.fn(async () => ({
    enabled: true,
    activation: "inactive",
    configValid: true,
    configErrors: [],
    artifacts: {
      captureBinary: false,
      helperDylib: false,
      helperKey: false,
      helperBuild: false,
    },
    driverStatus: "missing",
    note: "static",
  })),
}));

vi.mock("./runtime-api.js", () => ({ createFaceTimeRuntime: mocks.activateRuntime }));
vi.mock("./src/static-status.js", () => ({ inspectFaceTimeStaticStatus: mocks.staticStatus }));

import plugin from "./index.js";

describe("FaceTime control-plane registration", () => {
  it("serves gateway and model status without build, socket, injection, or runtime activation", async () => {
    const gatewayMethods = new Map<string, (options: unknown) => Promise<void>>();
    let toolFactory: (() => { execute(id: string, input: unknown): Promise<unknown> }) | undefined;
    const register = plugin.register;
    expect(register).toBeDefined();
    register!(
      createTestPluginApi({
        id: "facetime",
        name: "FaceTime",
        source: "test",
        rootDir: "/plugin",
        config: {},
        pluginConfig: { ownerHandles: ["owner@example.com"] },
        runtime: {
          system: { runCommandWithTimeout: vi.fn() },
        } as never,
        registerGatewayMethod: (name, handler) => {
          gatewayMethods.set(name, handler as (options: unknown) => Promise<void>);
        },
        registerTool: (factory) => {
          toolFactory = factory as unknown as typeof toolFactory;
        },
      }),
    );

    const respond = vi.fn();
    const statusMethod = gatewayMethods.get("facetime.status");
    expect(statusMethod).toBeDefined();
    await statusMethod!({ respond });
    expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ activation: "inactive" }));
    expect(toolFactory).toBeDefined();
    const tool = (
      toolFactory as unknown as () => {
        execute(id: string, input: unknown): Promise<unknown>;
      }
    )();
    await tool.execute("tool-1", { action: "get_status" });

    expect(mocks.staticStatus).toHaveBeenCalledTimes(2);
    expect(mocks.activateRuntime).not.toHaveBeenCalled();
  });
});
