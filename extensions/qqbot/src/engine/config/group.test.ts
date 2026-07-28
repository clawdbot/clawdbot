// Qqbot tests cover group plugin behavior.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GROUP_PROMPT,
  resolveGroupCommandLevelFromAccountConfig,
  resolveGroupConfig,
  resolveGroupSettings,
  resolveMentionPatterns,
} from "./group.js";

describe("engine/config/group", () => {
  describe("resolveGroupConfig precedence", () => {
    it("returns defaults when no config exists", () => {
      const cfg = resolveGroupConfig({}, "G1");
      expect(cfg).toStrictEqual({
        requireMention: true,
        ignoreOtherMentions: false,
        commandLevel: "all",
        name: "",
        prompt: undefined,
        historyLimit: 50,
      });
    });

    it("falls back to wildcard when specific is missing", () => {
      const cfg = {
        channels: {
          qqbot: {
            appId: "1",
            groups: {
              "*": {
                requireMention: false,
                commandLevel: "strict",
                historyLimit: 20,
                name: "wild",
              },
            },
          },
        },
      };
      const resolved = resolveGroupConfig(cfg, "G1");
      expect(resolved.requireMention).toBe(false);
      expect(resolved.commandLevel).toBe("strict");
      expect(resolved.historyLimit).toBe(20);
      expect(resolved.name).toBe("wild");
    });

    it("specific overrides wildcard and defaults", () => {
      const cfg = {
        channels: {
          qqbot: {
            appId: "1",
            groups: {
              "*": { requireMention: true, commandLevel: "strict", historyLimit: 20 },
              GROUPA: { requireMention: false, commandLevel: "all", historyLimit: 5, name: "A" },
            },
          },
        },
      };
      const resolved = resolveGroupConfig(cfg, "GROUPA");
      expect(resolved.requireMention).toBe(false);
      expect(resolved.commandLevel).toBe("all");
      expect(resolved.historyLimit).toBe(5);
      expect(resolved.name).toBe("A");
    });

    it("historyLimit is clamped to >= 0 and floored", () => {
      const cfg = {
        channels: {
          qqbot: { appId: "1", groups: { "*": { historyLimit: -3.7 } } },
        },
      };
      expect(resolveGroupConfig(cfg, "G").historyLimit).toBe(0);
    });

    it("non-finite historyLimit falls back to default", () => {
      const cfg = {
        channels: {
          qqbot: { appId: "1", groups: { "*": { historyLimit: "not a number" } } },
        },
      };
      expect(resolveGroupConfig(cfg, "G").historyLimit).toBe(50);
    });

    describe("account-level defaultRequireMention layer", () => {
      it("uses hardcoded true when nothing configured (default account)", () => {
        const cfg = { channels: { qqbot: { appId: "1" } } };
        expect(resolveGroupConfig(cfg, "G1").requireMention).toBe(true);
      });

      it("reads defaultRequireMention from top-level qqbot (default account)", () => {
        const cfg = {
          channels: { qqbot: { appId: "1", defaultRequireMention: false } },
        };
        expect(resolveGroupConfig(cfg, "G1").requireMention).toBe(false);
      });

      it("reads defaultRequireMention from named account config", () => {
        const cfg = {
          channels: {
            qqbot: {
              accounts: { bot2: { appId: "9", defaultRequireMention: false } },
            },
          },
        };
        expect(resolveGroupConfig(cfg, "G1", "bot2").requireMention).toBe(false);
      });

      it("wildcard overrides account-level defaultRequireMention", () => {
        const cfg = {
          channels: {
            qqbot: {
              appId: "1",
              defaultRequireMention: false,
              groups: { "*": { requireMention: true } },
            },
          },
        };
        // wildcard requireMention=true wins over account-level defaultRequireMention=false
        expect(resolveGroupConfig(cfg, "G1").requireMention).toBe(true);
      });

      it("specific group config has highest priority", () => {
        const cfg = {
          channels: {
            qqbot: {
              appId: "1",
              defaultRequireMention: false,
              groups: {
                "*": { requireMention: true },
                SPECIAL_GROUP: { requireMention: false },
              },
            },
          },
        };
        expect(resolveGroupConfig(cfg, "SPECIAL_GROUP").requireMention).toBe(false);
        expect(resolveGroupConfig(cfg, "OTHER_GROUP").requireMention).toBe(true); // wildcard
      });
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
      const resolved = resolveGroupConfig(cfg, "G", "bot2");
      expect(resolved.requireMention).toBe(false);
      expect(resolved.historyLimit).toBe(7);
    });
  });

  describe("resolveGroupCommandLevelFromAccountConfig", () => {
    it("defaults to all when unset", () => {
      expect(resolveGroupCommandLevelFromAccountConfig({}, "G")).toBe("all");
    });

    it("uses specific group before wildcard", () => {
      expect(
        resolveGroupCommandLevelFromAccountConfig(
          {
            groups: {
              "*": { commandLevel: "strict" },
              G1: { commandLevel: "all" },
            },
          },
          "G1",
        ),
      ).toBe("all");
    });
  });

  describe("group display name", () => {
    it("uses the first 8 chars of openid when name is unset", () => {
      expect(resolveGroupSettings({ cfg: {}, groupOpenid: "ABCDEFGH1234" }).name).toBe("ABCDEFGH");
    });

    it("prefers the configured name", () => {
      const cfg = {
        channels: { qqbot: { appId: "1", groups: { ABCDEFGH1234: { name: "Foo" } } } },
      };
      expect(resolveGroupSettings({ cfg, groupOpenid: "ABCDEFGH1234" }).name).toBe("Foo");
    });
  });

  describe("group prompt", () => {
    it("returns the default prompt when nothing configured", () => {
      expect(resolveGroupConfig({}, "G").prompt ?? DEFAULT_GROUP_PROMPT).toContain("bot");
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
      expect(resolveGroupConfig(cfg, "G1").prompt).toBe("SPEC");
      expect(resolveGroupConfig(cfg, "G2").prompt).toBe("WILD");
    });
  });

  describe("ignoreOtherMentions", () => {
    it("defaults to false", () => {
      expect(resolveGroupConfig({}, "G").ignoreOtherMentions).toBe(false);
    });

    it("honours wildcard override", () => {
      const cfg = {
        channels: { qqbot: { appId: "1", groups: { "*": { ignoreOtherMentions: true } } } },
      };
      expect(resolveGroupConfig(cfg, "G").ignoreOtherMentions).toBe(true);
    });
  });

  describe("resolveMentionPatterns", () => {
    it("returns [] when nothing configured", () => {
      expect(resolveMentionPatterns({})).toStrictEqual([]);
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
