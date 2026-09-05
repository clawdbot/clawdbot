import { describe, expect, it } from "vitest";
import { buzzSetupPlugin } from "../setup-plugin-api.js";
import { buzzPlugin } from "./channel.js";

describe("Buzz channel guidance", () => {
  it.each([
    ["runtime", buzzPlugin],
    ["setup", buzzSetupPlugin],
  ] as const)("%s opts into isolated named-account reloads", (_surface, plugin) => {
    expect(plugin.reload).toEqual({
      configPrefixes: ["channels.buzz"],
      accountScopedRestart: true,
    });
  });

  it.each([
    { mode: "off", automatic: true, flat: true },
    { mode: "all", automatic: true, flat: false },
    { mode: "off", automatic: false, flat: false },
  ] as const)(
    "routes $mode automatic=$automatic without flattening explicit tools",
    ({ mode, automatic, flat }) => {
      const original = { threadId: "thread-root", replyToId: "requested-parent" };
      const transport =
        buzzPlugin.threading?.resolveReplyTransport?.({
          cfg: {},
          ...original,
          replyToIsExplicit: !automatic,
          replyDelivery: automatic ? { replyToMode: mode } : undefined,
        }) ?? original;
      expect(transport).toEqual(flat ? { threadId: null, replyToId: null } : original);
    },
  );
  it("advertises directory room targets and native mention syntax", () => {
    const hints = buzzPlugin.agentPrompt?.messageToolHints?.({} as never) ?? [];

    expect(hints).toContain(
      "- Buzz targets: use a configured room UUID, `buzz:<ROOM_UUID>`, or a unique current room name. Use the UUID when room names are ambiguous.",
    );
    expect(hints).toContain(
      "- Buzz mentions: write a unique current room member as `@Display Name`. For an explicit identity, include `nostr:npub...`; the public key must belong to the target room. Any unresolved or ambiguous label needs an explicit identity for every intended member.",
    );
    expect(buzzPlugin.messaging?.targetResolver?.hint).toBe("<room UUID|configured room name>");
  });

  it("resolves Buzz reply sessions without treating the thread as part of the room UUID", () => {
    const roomId = "64f4debf-e7af-438c-8dcd-d6fbbe77405d";
    const threadId = "584e8d00bab48310ea80ff5f62550f824242bbc333fc4c259d7ae80be025c8aa";

    expect(
      buzzPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: `buzz:${roomId}:thread:${threadId}`,
      }),
    ).toEqual({
      id: roomId,
      threadId,
      baseConversationId: roomId,
      parentConversationCandidates: [roomId],
    });
  });
});
