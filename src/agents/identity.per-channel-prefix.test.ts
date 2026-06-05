// Documents response-prefix cascade across global, channel, and account scopes.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveResponsePrefix, resolveEffectiveMessagesConfig } from "./identity.js";

const makeConfig = <T extends OpenClawConfig>(cfg: T) => cfg;

describe("resolveResponsePrefix with per-channel override", () => {
  // ─── Backward compatibility ─────────────────────────────────────────

  describe("backward compatibility (no channel param)", () => {
    it("returns undefined when no prefix configured anywhere", () => {
      const cfg: OpenClawConfig = {};
      expect(resolveResponsePrefix(cfg, "main")).toBeUndefined();
    });

    it("returns global prefix when set", () => {
      const cfg: OpenClawConfig = { messages: { responsePrefix: "[Bot] " } };
      expect(resolveResponsePrefix(cfg, "main")).toBe("[Bot] ");
    });

    it("resolves 'auto' to identity name at global level", () => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", identity: { name: "TestBot" } }],
        },
        messages: { responsePrefix: "auto" },
      };
      expect(resolveResponsePrefix(cfg, "main")).toBe("[TestBot]");
    });

    it("returns empty string when global prefix is explicitly empty", () => {
      const cfg: OpenClawConfig = { messages: { responsePrefix: "" } };
      expect(resolveResponsePrefix(cfg, "main")).toBe("");
    });
  });

  // ─── Channel-level prefix ──────────────────────────────────────────

  describe("channel-level prefix", () => {
    it("returns channel prefix when set, ignoring global", () => {
      // Channel scope is more specific than the global messages default.
      const cfg = makeConfig({
        messages: { responsePrefix: "[Global] " },
        channels: {
          whatsapp: { responsePrefix: "[WA] " },
        },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp" })).toBe("[WA] ");
    });

    it("falls through to global when channel prefix is undefined", () => {
      const cfg = makeConfig({
        messages: { responsePrefix: "[Global] " },
        channels: {
          whatsapp: {},
        },
      } satisfies OpenClawConfig);
      expect(resolveResponsePrefix(cfg, "main", { channel: "whatsapp" })).toBe("[Global] ");
    });

    it("channel empty string stops cascade (no global prefix applied)", () => {
      // Empty string is an explicit operator choice, not an unset value.
      const cfg = makeConfig({
        messages: { responsePrefix: "[Global] " },
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
    it("returns account prefix when set, ignoring channel and global", () => {
      const cfg = makeConfig({
        messages: { responsePrefix: "[Global] " },
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

    it("falls through to global when both account and channel are undefined", () => {
      const cfg = makeConfig({
        messages: { responsePrefix: "[Global] " },
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
      ).toBe("[Global] ");
    });

    it("account empty string stops cascade", () => {
      const cfg = makeConfig({
        messages: { responsePrefix: "[Global] " },
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

  describe("full 4-level cascade", () => {
    // Specificity order: account, channel, agent/global identity fallback,
    // then global messages config.
    const fullCfg = makeConfig({
      agents: {
        list: [{ id: "main", identity: { name: "TestBot" } }],
      },
      messages: { responsePrefix: "[L4-Global] " },
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

    it("L4: global prefix when channel has no prefix", () => {
      expect(resolveResponsePrefix(fullCfg, "main", { channel: "telegram" })).toBe("[L4-Global] ");
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
        messages: { responsePrefix: "[Global] " },
        channels: {
          whatsapp: { responsePrefix: "[WA] " },
        },
      } satisfies OpenClawConfig);
      const result = resolveEffectiveMessagesConfig(cfg, "main", {
        channel: "whatsapp",
      });
      expect(result.responsePrefix).toBe("[WA] ");
    });

    it("uses global when no channel context provided", () => {
      const cfg = makeConfig({
        messages: { responsePrefix: "[Global] " },
        channels: {
          whatsapp: { responsePrefix: "[WA] " },
        },
      } satisfies OpenClawConfig);
      const result = resolveEffectiveMessagesConfig(cfg, "main");
      expect(result.responsePrefix).toBe("[Global] ");
    });
  });
});
