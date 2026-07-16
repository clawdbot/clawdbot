import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeWhatsAppMessageActions,
  resolveWhatsAppAgentReactionGuidance,
} from "./channel-actions.js";
import type { OpenClawConfig } from "./runtime-api.js";

const hoisted = vi.hoisted(() => ({
  listWhatsAppAccountIds: vi.fn((cfg: OpenClawConfig) => {
    const accountIds = Object.keys(cfg.channels?.whatsapp?.accounts ?? {});
    return accountIds.length > 0 ? accountIds : ["default"];
  }),
  resolveWhatsAppAccount: vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => ({
      enabled:
        accountId == null ? true : cfg.channels?.whatsapp?.accounts?.[accountId]?.enabled !== false,
    }),
  ),
}));

vi.mock("./channel-actions.runtime.js", async () => {
  return {
    listWhatsAppAccountIds: hoisted.listWhatsAppAccountIds,
    resolveWhatsAppAccount: hoisted.resolveWhatsAppAccount,
    createActionGate: (actions?: { reactions?: boolean; polls?: boolean }) => (name: string) => {
      if (name === "reactions") {
        return actions?.reactions !== false;
      }
      if (name === "polls") {
        return actions?.polls !== false;
      }
      return true;
    },
    resolveWhatsAppReactionLevel: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string;
    }) => {
      const accountLevel =
        accountId == null
          ? undefined
          : cfg.channels?.whatsapp?.accounts?.[accountId]?.reactionLevel;
      const level = accountLevel ?? cfg.channels?.whatsapp?.reactionLevel ?? "minimal";
      return {
        level,
        agentReactionsEnabled: level === "minimal" || level === "extensive",
        agentReactionGuidance: level === "minimal" || level === "extensive" ? level : undefined,
      };
    },
  };
});

describe("whatsapp channel action helpers", () => {
  beforeEach(() => {
    hoisted.listWhatsAppAccountIds.mockClear();
    hoisted.resolveWhatsAppAccount.mockClear();
  });

  it("defaults to minimal reaction guidance when reactions are available", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBe("minimal");
  });

  it("omits reaction guidance when WhatsApp is not configured", () => {
    expect(
      resolveWhatsAppAgentReactionGuidance({
        cfg: {} as OpenClawConfig,
        accountId: "default",
      }),
    ).toBeUndefined();
  });

  it("returns minimal reaction guidance when configured", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "minimal",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBe("minimal");
  });

  it("omits reaction guidance when WhatsApp reactions are disabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          actions: { reactions: false },
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBeUndefined();
  });

  it("omits reaction guidance when reactionLevel disables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(resolveWhatsAppAgentReactionGuidance({ cfg, accountId: "default" })).toBeUndefined();
  });

  it("advertises react when agent reactions are enabled", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(describeWhatsAppMessageActions({ cfg, accountId: "default" })?.actions).toEqual([
      "react",
      "poll",
    ]);
  });

  it("returns null when WhatsApp is not configured", () => {
    expect(
      describeWhatsAppMessageActions({ cfg: {} as OpenClawConfig, accountId: "default" }),
    ).toBeNull();
  });

  it("omits react when reactionLevel disables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
        },
      },
    } as OpenClawConfig;

    expect(describeWhatsAppMessageActions({ cfg, accountId: "default" })?.actions).toEqual([
      "poll",
    ]);
  });

  it("uses the active account reactionLevel for discovery", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(describeWhatsAppMessageActions({ cfg, accountId: "work" })?.actions).toEqual([
      "react",
      "poll",
    ]);
  });

  it("keeps react in global discovery when any account enables agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;
    hoisted.listWhatsAppAccountIds.mockReturnValue(["default", "work"]);

    expect(describeWhatsAppMessageActions({ cfg })?.actions).toEqual(["react", "poll"]);
  });

  it("omits react in global discovery when only disabled accounts enable agent reactions", () => {
    const cfg = {
      channels: {
        whatsapp: {
          reactionLevel: "ack",
          allowFrom: ["*"],
          accounts: {
            work: {
              enabled: false,
              reactionLevel: "minimal",
            },
          },
        },
      },
    } as OpenClawConfig;
    hoisted.listWhatsAppAccountIds.mockReturnValue(["default", "work"]);

    expect(describeWhatsAppMessageActions({ cfg })?.actions).toEqual(["poll"]);
  });
});
