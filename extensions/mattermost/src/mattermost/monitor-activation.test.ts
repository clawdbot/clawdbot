// Mattermost tests cover shared mention activation wiring.
import { describe, expect, it } from "vitest";
import { resolveMattermostInboundMentionDecision } from "./monitor-activation.js";

function resolveThreadDecision(params?: {
  accountId?: string;
  cfg?: Record<string, unknown>;
  wasMentioned?: boolean;
  commandAuthorized?: boolean;
}) {
  return resolveMattermostInboundMentionDecision({
    cfg: (params?.cfg ?? {}) as never,
    accountId: params?.accountId ?? "default",
    kind: "channel",
    requireMention: true,
    canDetectMention: true,
    wasMentioned: params?.wasMentioned ?? false,
    implicitMentionKinds: ["bot_thread_participant"],
    allowTextCommands: true,
    hasControlCommand: params?.commandAuthorized ?? false,
    commandAuthorized: params?.commandAuthorized ?? false,
  });
}

describe("mattermost monitor activation", () => {
  it("keeps participated-thread follow-ups enabled by default", () => {
    expect(resolveThreadDecision()).toMatchObject({
      shouldSkip: false,
      effectiveWasMentioned: true,
      matchedImplicitMentionKinds: ["bot_thread_participant"],
    });
  });

  it("applies account policy before channel policy", () => {
    const cfg = {
      channels: {
        mattermost: {
          implicitMentions: { threadParticipation: true },
          accounts: {
            work: { implicitMentions: { threadParticipation: false } },
          },
        },
      },
    };
    expect(resolveThreadDecision({ cfg })).toMatchObject({ shouldSkip: false });
    expect(resolveThreadDecision({ cfg, accountId: "work" })).toMatchObject({
      shouldSkip: true,
      effectiveWasMentioned: false,
      matchedImplicitMentionKinds: [],
    });
  });

  it("keeps explicit mentions and authorized commands independent from implicit policy", () => {
    const cfg = {
      channels: {
        mattermost: { implicitMentions: { threadParticipation: false } },
      },
    };
    expect(resolveThreadDecision({ cfg, wasMentioned: true })).toMatchObject({
      shouldSkip: false,
      effectiveWasMentioned: true,
    });
    expect(resolveThreadDecision({ cfg, commandAuthorized: true })).toMatchObject({
      shouldSkip: false,
      shouldBypassMention: true,
    });
  });
});
