import { describe, expect, it } from "vitest";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("legacy config migrate validation", () => {
  it("returns valid migrated config for legacy group chat routing drift", () => {
    const res = migrateLegacyConfig({
      routing: {
        allowFrom: ["+15550001111"],
        groupChat: {
          requireMention: false,
          historyLimit: 8,
          mentionPatterns: ["@openclaw"],
        },
      },
      channels: {
        whatsapp: {},
        telegram: {},
      },
    });

    expect(res.partiallyValid).toBeUndefined();
    const migratedConfig = res.config as Record<string, unknown> | null;
    expect(migratedConfig?.routing).toBeUndefined();
    expect(res.config?.channels?.whatsapp?.allowFrom).toEqual(["+15550001111"]);
    expect(res.config?.channels?.whatsapp?.groups).toEqual({
      "*": { requireMention: false },
    });
    expect(res.config?.channels?.telegram?.groups).toEqual({
      "*": { requireMention: false },
    });
    expect(res.config?.messages?.groupChat).toEqual({
      historyLimit: 8,
      mentionPatterns: ["@openclaw"],
    });
    expect(res.changes).toStrictEqual([
      "Moved routing.allowFrom → channels.whatsapp.allowFrom.",
      'Moved routing.groupChat.requireMention → channels.whatsapp.groups."*".requireMention.',
      'Moved routing.groupChat.requireMention → channels.telegram.groups."*".requireMention.',
      "Moved routing.groupChat.historyLimit → messages.groupChat.historyLimit.",
      "Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.",
    ]);
  });

  it("returns migrated config when unrelated plugin validation issues remain (#76798)", () => {
    const res = migrateLegacyConfig({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          llm: { idleTimeoutSeconds: 120 },
        },
      },
      plugins: {
        entries: {
          brave: {
            enabled: true,
            config: { webSearch: { mode: "definitely-invalid" } },
          },
        },
      },
      tools: { web: { search: { provider: "brave" } } },
    });

    expect(res.partiallyValid).toBe(true);
    expect(res.changes).toStrictEqual([
      "Removed agents.defaults.llm; model idle timeout now follows models.providers.<id>.timeoutSeconds.",
      "Migration applied; other validation issues remain — run doctor to review.",
    ]);
    expect(res.config?.agents?.defaults).toEqual({
      model: { primary: "openai/gpt-5.5" },
    });
    expect(res.config?.tools?.web?.search?.provider).toBe("brave");
  });
});
