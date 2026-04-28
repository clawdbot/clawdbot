import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_HISTORY_LIMIT,
  resolveGroupConfig,
  resolveGroupName,
  resolveGroupPrompt,
  resolveGroupSettings,
  resolveGroupToolPolicy,
  resolveHistoryLimit,
  resolveIgnoreOtherMentions,
  resolveMentionPatterns,
  resolveRequireMention,
} from "./group.js";

describe("engine/config/group", () => {
  describe("resolveGroupConfig precedence", () => {
    it("returns defaults when no config exists", () => {
      const cfg = resolveGroupConfig({}, "G1");
      expect(cfg).toMatchObject({
        requireMention: true,
        ignoreOtherMentions: false,
        toolPolicy: "restricted",
        name: "",
        historyLimit: DEFAULT_GROUP_HISTORY_LIMIT,
      });
      expect(cfg.prompt).toBeUndefined();
    });

    it("falls back to wildcard when specific is missing", () => {
      const cfg = {
        channels: {
          qqbot: {
            appId: "1",
            groups: {
              "*": {
                requireMention: false,
                toolPolicy: "full",
                historyLimit: 20,
                name: "wild",
              },
            },
          },
        },
      };
      const resolved = resolveGroupConfig(cfg, "G1");
      expect(resolved.requireMention).toBe(false);
      expect(resolved.toolPolicy).toBe("full");
      expect(resolved.historyLimit).toBe(20);
      expect(resolved.name).toBe("wild");
    });

    it("specific overrides wildcard and defaults", () => {
      const cfg = {
        channels: {
          qqbot: {
            appId: "1",
            groups: {
              "*": { requireMention: true, toolPolicy: "restricted", historyLimit: 20 },
              GROUPA: { requireMention: false, toolPolicy: "none", historyLimit: 5, name: "A" },
            },
          },
        },
      };
      const resolved = resolveGroupConfig(cfg, "GROUPA");
      expect(resolved.requireMention).toBe(false);
      expect(resolved.toolPolicy).toBe("none");
      expect(resolved.historyLimit).toBe(5);
      expect(resolved.name).toBe("A");
    });

    it("historyLimit is clamped to >= 0 and floored", () => {
      const cfg = {
        channels: {
          qqbot: { appId: "1", groups: { "*": { historyLimit: -3.7 } } },
        },
      };
      expect(resolveHistoryLimit(cfg, "G")).toBe(0);
    });

    it("non-finite historyLimit falls back to default", () => {
      const cfg = {
        channels: {
          qqbot: { appId: "1", groups: { "*": { historyLimit: "not a number" } } },
        },
      };
      expect(resolveHistoryLimit(cfg, "G")).toBe(DEFAULT_GROUP_HISTORY_LIMIT);
    });

    it("invalid toolPolicy values are ignored", () => {
      const cfg = {
        channels: {
          qqbot: { appId: "1", groups: { "*": { toolPolicy: "invalid" } } },
        },
      };
      expect(resolveGroupToolPolicy(cfg, "G")).toBe("restricted");
    });
  });

  describe("named accounts", () => {
    it("reads groups from the named-account scope", () => {
      const cfg = {
        channels: {
          qqbot: {
            accounts: {
              bot2: {
                appId: "9",
                groups: { "*": { requireMention: false, historyLimit: 7 } },
              },
            },
          },
        },
      };
      expect(resolveRequireMention(cfg, "G", "bot2")).toBe(false);
      expect(resolveHistoryLimit(cfg, "G", "bot2")).toBe(7);
    });
  });

  describe("resolveGroupName", () => {
    it("uses the first 8 chars of openid when name is unset", () => {
      expect(resolveGroupName({}, "ABCDEFGH1234")).toBe("ABCDEFGH");
    });

    it("prefers the configured name", () => {
      const cfg = {
        channels: { qqbot: { appId: "1", groups: { ABCDEFGH1234: { name: "Foo" } } } },
      };
      expect(resolveGroupName(cfg, "ABCDEFGH1234")).toBe("Foo");
    });
  });

  describe("resolveGroupPrompt", () => {
    it("returns the default prompt when nothing configured", () => {
      expect(resolveGroupPrompt({}, "G")).toContain("bot");
    });

    it("prefers specific over wildcard", () => {
      const cfg = {
        channels: {
          qqbot: {
            appId: "1",
            groups: { "*": { prompt: "WILD" }, G1: { prompt: "SPEC" } },
          },
        },
      };
      expect(resolveGroupPrompt(cfg, "G1")).toBe("SPEC");
      expect(resolveGroupPrompt(cfg, "G2")).toBe("WILD");
    });
  });

  describe("resolveIgnoreOtherMentions", () => {
    it("defaults to false", () => {
      expect(resolveIgnoreOtherMentions({}, "G")).toBe(false);
    });

    it("honours wildcard override", () => {
      const cfg = {
        channels: { qqbot: { appId: "1", groups: { "*": { ignoreOtherMentions: true } } } },
      };
      expect(resolveIgnoreOtherMentions(cfg, "G")).toBe(true);
    });
  });

  describe("resolveMentionPatterns", () => {
    it("returns [] when nothing configured", () => {
      expect(resolveMentionPatterns({})).toEqual([]);
    });

    it("reads global patterns", () => {
      const cfg = { messages: { groupChat: { mentionPatterns: ["/^hey/"] } } };
      expect(resolveMentionPatterns(cfg)).toEqual(["/^hey/"]);
    });

    it("agent-level overrides global", () => {
      const cfg = {
        messages: { groupChat: { mentionPatterns: ["g"] } },
        agents: {
          list: [{ id: "main", groupChat: { mentionPatterns: ["a", "b"] } }],
        },
      };
      expect(resolveMentionPatterns(cfg, "main")).toEqual(["a", "b"]);
      expect(resolveMentionPatterns(cfg, "OTHER")).toEqual(["g"]);
    });

    it("filters non-string entries", () => {
      const cfg = { messages: { groupChat: { mentionPatterns: ["ok", 42, null] } } };
      expect(resolveMentionPatterns(cfg)).toEqual(["ok"]);
    });
  });

  describe("resolveGroupSettings (aggregate)", () => {
    it("returns merged config + name + mentionPatterns in one call", () => {
      const cfg = {
        channels: {
          qqbot: {
            appId: "1",
            groups: {
              G1: { requireMention: false, name: "Dev" },
              "*": { historyLimit: 10 },
            },
          },
        },
        messages: { groupChat: { mentionPatterns: ["@bot"] } },
      };
      const settings = resolveGroupSettings({ cfg, groupOpenid: "G1" });
      expect(settings.config.requireMention).toBe(false);
      expect(settings.config.historyLimit).toBe(10);
      expect(settings.name).toBe("Dev");
      expect(settings.mentionPatterns).toEqual(["@bot"]);
    });

    it("falls back to the first 8 chars of the openid for name", () => {
      const settings = resolveGroupSettings({
        cfg: {},
        groupOpenid: "ABCDEFGHIJKLMNOP",
      });
      expect(settings.name).toBe("ABCDEFGH");
    });

    it("applies agent-level mentionPatterns over global", () => {
      const cfg = {
        agents: {
          list: [{ id: "custom", groupChat: { mentionPatterns: ["@agent"] } }],
        },
        messages: { groupChat: { mentionPatterns: ["@global"] } },
      };
      const settings = resolveGroupSettings({
        cfg,
        groupOpenid: "G1",
        agentId: "custom",
      });
      expect(settings.mentionPatterns).toEqual(["@agent"]);
    });
  });
});
