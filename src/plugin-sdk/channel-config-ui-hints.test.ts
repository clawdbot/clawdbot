import { describe, expect, it } from "vitest";
import { createChannelConfigUiHints } from "./channel-config-ui-hints.js";

describe("channel config UI hint helpers", () => {
  it("builds canonical and legacy DM policy hints", () => {
    expect(
      createChannelConfigUiHints({
        channelLabel: "Example",
        dmPolicy: { channelKey: "example", includeLegacyNestedPolicy: true },
      }),
    ).toEqual({
      "dm.policy": {
        label: "Example DM Policy",
        help: 'Direct message access control ("pairing" recommended). "open" requires channels.example.allowFrom=["*"] (legacy: channels.example.dm.allowFrom).',
      },
      dmPolicy: {
        label: "Example DM Policy",
        help: 'Direct message access control ("pairing" recommended). "open" requires channels.example.allowFrom=["*"].',
      },
    });
  });

  it("builds the shared progress hint group", () => {
    const hints = createChannelConfigUiHints({ channelLabel: "Example", progress: {} });
    expect(Object.keys(hints)).toEqual([
      "streaming.progress.label",
      "streaming.progress.labels",
      "streaming.progress.maxLines",
      "streaming.progress.maxLineChars",
      "streaming.progress.toolProgress",
      "streaming.progress.commandText",
    ]);
    expect(hints["streaming.progress.label"]?.label).toBe("Example Progress Label");
  });

  it("builds the shared implicit mention hint group", () => {
    const hints = createChannelConfigUiHints({
      channelLabel: "Example",
      implicitMentions: true,
    });
    expect(Object.keys(hints)).toEqual([
      "implicitMentions",
      "implicitMentions.replyToBot",
      "implicitMentions.quotedBot",
      "implicitMentions.threadParticipation",
    ]);
    expect(hints["implicitMentions.threadParticipation"]?.label).toBe(
      "Example Thread Participation",
    );
  });
});
