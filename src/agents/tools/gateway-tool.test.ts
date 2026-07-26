import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayTool } from "./gateway-tool.js";

const { callGatewayToolMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: vi.fn(() => ({})),
}));

describe("gateway tool", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
  });

  it("exposes only read actions", () => {
    const tool = createGatewayTool();
    const parameters = tool.parameters as {
      properties?: { action?: { enum?: string[] } };
    };

    expect(parameters.properties?.action?.enum).toEqual(["config.get", "config.schema.lookup"]);
    expect(tool.description).toBe(
      "Read gateway config + schema. Writes/restart: use openclaw tool.",
    );
  });

  it.each(["restart", "config.apply", "config.patch", "update.run"])(
    "rejects removed action %s",
    async (action) => {
      const tool = createGatewayTool();

      await expect(tool.execute?.("tool-call", { action })).rejects.toThrow(
        `Unknown action: ${action}`,
      );
      expect(callGatewayToolMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["config.get", { action: "config.get" }],
    ["config.schema.lookup", { action: "config.schema.lookup", path: "channels" }],
  ])("forwards the abort signal for %s", async (method, params) => {
    const controller = new AbortController();

    await createGatewayTool().execute("tool-call", params, controller.signal);

    expect(callGatewayToolMock).toHaveBeenCalledWith(method, expect.anything(), expect.anything(), {
      signal: controller.signal,
    });
  });
});
