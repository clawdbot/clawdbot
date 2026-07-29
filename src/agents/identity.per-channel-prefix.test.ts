// Documents response-prefix cascade across global, channel, and account scopes.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveResponsePrefix, resolveEffectiveMessagesConfig } from "./identity.js";

const makeConfig = <T extends OpenClawConfig>(cfg: T) => cfg;

describe("resolveResponsePrefix with per-channel override", () => {
  it("keeps the global fallback when no channel block exists", () => {
    const cfg: OpenClawConfig = { messages: { responsePrefix: "[Bot] " } };
    expect(resolveResponsePrefix(cfg, "main", { channel: "telegram" })).toBe("[Bot] ");
  });

  it("keeps the global fallback for a configured custom channel", () => {
    const cfg = {
      messages: { responsePrefix: "[Bot] " },
      channels: { custom: { enabled: true } },
    } as OpenClawConfig;
    expect(resolveResponsePrefix(cfg, "main", { channel: "custom" })).toBe("[Bot] ");
  });

  // ─── Channel-level prefix ──────────────────────────────────────────

  describe("channel-level prefix", () => {
    it("returns the configured channel prefix", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: { responsePrefix: "[WA] " },
        },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp" })).toBe("[WA] ");
    });

    it("returns undefined when channel prefix is undefined", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: {},
        },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp" })).toBeUndefined();
    });

    it("channel empty string stops cascade (no global prefix applied)", () => {
      // Empty string is an explicit operator choice, not an unset value.
      const cfg = makeConfig({
        channels: {
          telegram: { responsePrefix: "" },
        },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "telegram" })).toBe("");
    });

    it("resolves 'auto' at channel level to identity name", () => {
      const cfg = makeConfig({
        agents: {
          list: [{ id: "main", identity: { name: "MyBot" } }],
        },
        channels: {
          whatsapp: { responsePrefix: "auto" },
        },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp" })).toBe("[MyBot]");
    });

    it("different channels get different prefixes", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: { responsePrefix: "[WA Bot] " },
          telegram: { responsePrefix: "" },
          discord: { responsePrefix: "🤖 " },
        },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp" })).toBe("[WA Bot] ");
      expect(resolveResponsePrefix(cfg, "main", { channel: "telegram" })).toBe("");
      expect(resolveResponsePrefix(cfg, "main", { channel: "discord" })).toBe("🤖 ");
    });

    it("returns undefined when channel not in config", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: { responsePrefix: "[WA] " },
        },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "telegram" })).toBeUndefined();
    });
  });

  // ─── Account-level prefix ─────────────────────────────────────────

  describe("account-level prefix", () => {
    it("returns account prefix when set, ignoring the channel prefix", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: {
            responsePrefix: "[WA] ",
            accounts: {
              business: { responsePrefix: "[Biz] " },
            },
          },
        },
      } satisfies OpenClawConfig);
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("[Biz] ");
    });

    it("falls through to channel prefix when account prefix is undefined", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: {
            responsePrefix: "[WA] ",
            accounts: {
              business: {},
            },
          },
        },
      } satisfies OpenClawConfig);
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("[WA] ");
    });

    it("returns undefined when both account and channel are undefined", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: {
            accounts: {
              business: {},
            },
          },
        },
      } satisfies OpenClawConfig);
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBeUndefined();
    });

    it("account empty string stops cascade", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: {
            responsePrefix: "[WA] ",
            accounts: {
              business: { responsePrefix: "" },
            },
          },
        },
      } satisfies OpenClawConfig);
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("");
    });

    it("resolves 'auto' at account level to identity name", () => {
      const cfg = makeConfig({
        agents: {
          list: [{ id: "main", identity: { name: "BizBot" } }],
        },
        channels: {
          whatsapp: {
            accounts: {
              business: { responsePrefix: "auto" },
            },
          },
        },
      } satisfies OpenClawConfig);
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("[BizBot]");
    });

    it("different accounts on same channel get different prefixes", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: {
            responsePrefix: "[WA] ",
            accounts: {
              business: { responsePrefix: "[Biz] " },
              personal: { responsePrefix: "[Personal] " },
            },
          },
        },
      } satisfies OpenClawConfig);
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("[Biz] ");
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "personal" }),
      ).toBe("[Personal] ");
    });

    it("unknown accountId falls through to channel level", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: {
            responsePrefix: "[WA] ",
            accounts: {
              business: { responsePrefix: "[Biz] " },
            },
          },
        },
      } satisfies OpenClawConfig);
      expect(
        resolveResponsePrefix(cfg, "main", { channel: "whatsapp", accountId: "unknown" }),
      ).toBe("[WA] ");
    });
  });

  // ─── Full cascade ─────────────────────────────────────────────────

  describe("full channel/account cascade", () => {
    const fullCfg = makeConfig({
      agents: {
        list: [{ id: "main", identity: { name: "TestBot" } }],
      },
      channels: {
        whatsapp: {
          responsePrefix: "[L2-Channel] ",
          accounts: {
            business: { responsePrefix: "[L1-Account] " },
            default: {},
          },
        },
        telegram: {},
      },
    } satisfies OpenClawConfig);

    it("L1: account prefix wins when all levels set", () => {
      expect(
        resolveResponsePrefix(fullCfg, "main", { channel: "whatsapp", accountId: "business" }),
      ).toBe("[L1-Account] ");
    });

    it("L2: channel prefix when account undefined", () => {
      expect(
        resolveResponsePrefix(fullCfg, "main", { channel: "whatsapp", accountId: "default" }),
      ).toBe("[L2-Channel] ");
    });

    it("returns undefined when the channel has no prefix", () => {
      expect(resolveResponsePrefix(fullCfg, "main", { channel: "telegram" })).toBeUndefined();
    });

    it("undefined: no prefix at any level", () => {
      const cfg = makeConfig({
        channels: { telegram: {} },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "telegram" })).toBeUndefined();
    });
  });

  // ─── resolveEffectiveMessagesConfig integration ────────────────────

  describe("resolveEffectiveMessagesConfig with channel context", () => {
    it("passes channel context through to responsePrefix resolution", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: { responsePrefix: "[WA] " },
        },
      } satisfies OpenClawConfig);
      const result = resolveEffectiveMessagesConfig(cfg, "main", {
        channel: "whatsapp",
      });
      expect(result.responsePrefix).toBe("[WA] ");
    });

    it("returns undefined when no channel context is provided", () => {
      const cfg = makeConfig({
        channels: {
          whatsapp: { responsePrefix: "[WA] " },
        },
      } satisfies OpenClawConfig);
      const result = resolveEffectiveMessagesConfig(cfg, "main");
      expect(result.responsePrefix).toBeUndefined();
    });
  });
});
