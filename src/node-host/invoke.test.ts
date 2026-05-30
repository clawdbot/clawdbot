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

  it("includes effective exec policy in system.run.prepare responses", async () => {
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const skillBins: SkillBinsProvider = { current: async () => [] };

    await handleInvoke(
      {
        id: "invoke-1",
        nodeId: "node-1",
        command: "system.run.prepare",
        paramsJSON: JSON.stringify({
          command: ["echo", "ok"],
          rawCommand: "echo ok",
          agentId: "main",
          sessionKey: "agent:main:main",
        }),
      },
      { request } as unknown as GatewayClient,
      skillBins,
    );

    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({
        ok: true,
        payloadJSON: expect.any(String),
      }),
    );
    const result = request.mock.calls.find(([method]) => method === "node.invoke.result")?.[1] as {
      payloadJSON?: string;
    };
    const payload = JSON.parse(result.payloadJSON ?? "{}") as {
      execPolicy?: { security?: string; ask?: string };
    };
    expect(payload.execPolicy).toEqual({ security: "allowlist", ask: "on-miss" });
  });
});
