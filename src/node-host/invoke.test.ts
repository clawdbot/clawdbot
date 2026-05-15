import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { SkillBinsProvider } from "./invoke-types.js";
import { handleInvoke } from "./invoke.js";

describe("node host invoke", () => {
  it("wraps malformed paramsJSON for built-in commands", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };

    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: "system.run",
        paramsJSON: "{not json",
      },
      { request } as unknown as GatewayClient,
      skillBins,
    );

    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        id: "invoke-1",
        nodeId: "node-1",
        ok: false,
        error: expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("paramsJSON malformed JSON"),
        }),
      }),
    );
  });
});
