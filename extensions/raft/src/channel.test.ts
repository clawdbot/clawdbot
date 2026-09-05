import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { raftPlugin } from "./channel.js";

const detectBinaryMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/setup-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/setup-tools")>()),
  detectBinary: detectBinaryMock,
}));

describe("Raft channel plugin", () => {
  beforeEach(() => {
    detectBinaryMock.mockReset();
  });

  it("declares a wake-only direct channel", () => {
    expect(raftPlugin.meta).toMatchObject({
      id: "raft",
      docsPath: "/channels/raft",
    });
    expect(raftPlugin.capabilities).toEqual({
      chatTypes: ["direct"],
    });
    expect(raftPlugin.message).toBeUndefined();
    expect(raftPlugin.outbound).toBeUndefined();
  });

  it.each([
    {
      detected: true,
      expected: { ok: true, cliFound: true, error: null },
    },
    {
      detected: false,
      expected: {
        ok: false,
        cliFound: false,
        error: "Raft CLI not found on the Gateway PATH",
      },
    },
  ])(
    "maps CLI detection to a coherent status outcome when detected=$detected",
    async ({ detected, expected }) => {
      detectBinaryMock.mockResolvedValueOnce(detected);
      const cfg = {
        channels: {
          raft: {
            profile: "test-profile",
          },
        },
      } as OpenClawConfig;
      const account = raftPlugin.config.resolveAccount(cfg, "default");

      const result = await raftPlugin.status!.probeAccount!({
        account,
        timeoutMs: 1_000,
        cfg,
      });

      expect(detectBinaryMock).toHaveBeenCalledOnce();
      expect(detectBinaryMock).toHaveBeenCalledWith("raft");
      expect(result).toEqual(expected);
    },
  );
});
