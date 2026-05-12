import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { typedCases } from "../../test-utils/typed-cases.js";
import {
  createOutboundPayloadPlan,
  formatOutboundPayloadLog,
  normalizeOutboundPayloads,
  normalizeOutboundPayloadsForJson,
  normalizeReplyPayloadsForDelivery,
  projectOutboundPayloadPlanForDelivery,
  projectOutboundPayloadPlanForJson,
  projectOutboundPayloadPlanForMirror,
  projectOutboundPayloadPlanForOutbound,
  summarizeOutboundPayloadForTransport,
} from "./payloads.js";
import { registerPendingSpawnedChildrenQuery } from "./pending-spawn-query.js";

function resolveMirrorProjection(payloads: readonly ReplyPayload[]) {
  const normalized = normalizeReplyPayloadsForDelivery(payloads);
  return {
    text: normalized
      .map((payload) => payload.text)
      .filter((text): text is string => Boolean(text))
      .join("\n"),
    mediaUrls: normalized.flatMap(
      (payload) => resolveSendableOutboundReplyParts(payload).mediaUrls,
    ),
  };
}

describe("normalizeReplyPayloadsForDelivery", () => {
  it("parses directives, merges media, and preserves reply metadata", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        {
          text: "[[reply_to: 123]] Hello [[audio_as_voice]]\nMEDIA:https://x.test/a.png",
          mediaUrl: " https://x.test/a.png ",
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
          replyToTag: false,
        },
      ]),
    ).toEqual([
      {
        text: "Hello",
        mediaUrl: undefined,
        mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        replyToId: "123",
        replyToTag: true,
        replyToCurrent: undefined,
        audioAsVoice: true,
      },
    ]);
  });

  it("drops silent payloads without media and suppresses reasoning payloads", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "NO_REPLY" },
        { text: "Reasoning:\n_step_", isReasoning: true },
        { text: "final answer" },
      ]),
    ).toEqual([
      {
        text: "final answer",
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });

  it("suppresses relay status placeholder payloads", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "No channel reply." },
        { text: "Replied in-thread." },
        { text: "Replied in #maintainers." },
        {
          text: "Updated [wiki/providers.md](/Users/steipete/.openclaw/workspace/wiki/providers.md:33). No channel reply.",
        },
        {
          text: "Updated [wiki/tools.md] with the rollback failure-mode nuance. No channel reply.",
        },
      ]),
    ).toStrictEqual([]);
  });

  it("keeps normal payloads that mention wiki without matching relay placeholders", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "Please update wiki/tools.md after this ships." },
      ]),
    ).toEqual([
      {
        text: "Please update wiki/tools.md after this ships.",
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });

  it("drops JSON NO_REPLY action payloads without media", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: '{"action":"NO_REPLY"}' },
        { text: '{\n  "action": "NO_REPLY"\n}' },
      ]),
    ).toStrictEqual([]);
  });

  it("keeps JSON NO_REPLY objects that include extra fields", () => {
    expect(
      normalizeReplyPayloadsForDelivery([{ text: '{"action":"NO_REPLY","note":"example"}' }]),
    ).toEqual([
      {
        text: '{"action":"NO_REPLY","note":"example"}',
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });

  it("keeps mixed NO_REPLY text literal and only suppresses exact sentinel payloads", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "NO_REPLY thanks for the update" },
        { text: "NO_REPLY" },
        { text: "thanks NO_REPLY" },
      ]),
    ).toEqual([
      {
        text: "NO_REPLY thanks for the update",
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
      {
        text: "thanks NO_REPLY",
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });

  it("keeps silent token payloads when media exists", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "NO_REPLY", mediaUrl: "https://x.test/one.png" },
        { text: '{"action":"NO_REPLY"}', mediaUrls: ["https://x.test/two.png"] },
      ]),
    ).toEqual([
      {
        text: "",
        mediaUrls: ["https://x.test/one.png"],
        mediaUrl: "https://x.test/one.png",
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
      {
        text: "",
        mediaUrls: ["https://x.test/two.png"],
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });

  it("rewrites bare silent replies for direct conversations where silence is disallowed", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
        },
      },
    };

    const sessionKey = "agent:main:telegram:direct:123";
    const projected = projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
        cfg,
        sessionKey,
        surface: "telegram",
      }),
    );
    expect(projected).toHaveLength(1);
    const [reply] = projected;
    if (!reply?.text) {
      throw new Error("expected direct silent reply rewrite to produce visible text");
    }
    expect(reply.text).toBe("Nothing additional from me.");
  });

  it("drops bare silent replies for groups when policy allows silence", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
        },
      },
    };

    expect(
      projectOutboundPayloadPlanForDelivery(
        createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
          cfg,
          sessionKey: "agent:main:telegram:group:123",
          surface: "telegram",
        }),
      ),
    ).toStrictEqual([]);
  });

  it("does not add silent-reply chatter when visible content is already being delivered", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
        },
      },
    };

    const delivery = projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([{ text: "NO_REPLY" }, { text: "visible reply" }], {
        cfg,
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      }),
    );
    expect(delivery).toHaveLength(1);
    expect(delivery[0]?.text).toBe("visible reply");
  });

  describe("pending spawned subagent children", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: { direct: "disallow", group: "allow", internal: "allow" },
        },
      },
    };
    const planSilent = (sessionKey: string, hasPendingSpawnedChildren?: boolean) =>
      projectOutboundPayloadPlanForDelivery(
        createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
          cfg,
          sessionKey,
          surface: "telegram",
          hasPendingSpawnedChildren,
        }),
      );

    it("drops bare silent replies when the context flag is set", () => {
      expect(planSilent("agent:main:telegram:direct:123", true)).toStrictEqual([]);
    });

    it("drops bare silent replies via the registered runtime query", () => {
      const sessionKey = "agent:main:telegram:direct:456";
      const previousQuery = registerPendingSpawnedChildrenQuery((key) => key === sessionKey);
      try {
        expect(planSilent(sessionKey)).toStrictEqual([]);
      } finally {
        registerPendingSpawnedChildrenQuery(previousQuery);
      }
    });

    it("falls back to the visible rewrite path when the query throws", () => {
      const previousQuery = registerPendingSpawnedChildrenQuery(() => {
        throw new Error("registry unavailable");
      });
      try {
        const delivery = planSilent("agent:main:telegram:direct:789");
        expect(delivery).toHaveLength(1);
        const [reply] = delivery;
        if (!reply?.text) {
          throw new Error("expected visible silent-reply fallback text");
        }
        expect(reply.text).toBe("No extra notes from me.");
      } finally {
        registerPendingSpawnedChildrenQuery(previousQuery);
      }
    });
  });

  it("keeps bare NO_REPLY visible when silence is disallowed and rewrite is disabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          silentReply: {
            direct: "disallow",
            group: "allow",
            internal: "allow",
          },
          silentReplyRewrite: {
            direct: false,
          },
        },
      },
    };

    const delivery = projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
        cfg,
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      }),
    );
    expect(delivery).toHaveLength(1);
    expect(delivery[0]?.text).toBe("NO_REPLY");
  });

  it("is idempotent for already-normalized delivery payloads", () => {
    const once = normalizeReplyPayloadsForDelivery([
      {
        text: "Hello",
        mediaUrls: ["https://x.test/a.png"],
        replyToId: "123",
        replyToTag: true,
        replyToCurrent: true,
        audioAsVoice: true,
      },
      {
        text: "",
        channelData: { provider: "line" },
      },
    ]);
    const twice = normalizeReplyPayloadsForDelivery(once);
    expect(twice).toEqual(once);
  });

  it("captures a tricky payload matrix snapshot", () => {
    const input: ReplyPayload[] = [
      { text: "NO_REPLY" },
      { text: "NO_REPLY with details" },
      { text: '{"action":"NO_REPLY"}' },
      { text: '{"action":"NO_REPLY","note":"keep"}' },
      { text: "NO_REPLY", mediaUrl: "https://x.test/m1.png" },
      { text: "MEDIA:https://x.test/m2.png\n[[audio_as_voice]] [[reply_to: 444]] hi" },
      { text: "headline", btw: { question: "what changed?" } },
      { text: " \n\t ", channelData: { mode: "custom" } },
      { text: "Reasoning block", isReasoning: true },
    ];
    expect(normalizeReplyPayloadsForDelivery(input)).toMatchInlineSnapshot(`
      [
        {
          "audioAsVoice": false,
          "mediaUrl": undefined,
          "mediaUrls": undefined,
          "replyToCurrent": undefined,
          "replyToId": undefined,
          "replyToTag": false,
          "text": "NO_REPLY with details",
        },
        {
          "audioAsVoice": false,
          "mediaUrl": undefined,
          "mediaUrls": undefined,
          "replyToCurrent": undefined,
          "replyToId": undefined,
          "replyToTag": false,
          "text": "{"action":"NO_REPLY","note":"keep"}",
        },
        {
          "audioAsVoice": false,
          "mediaUrl": "https://x.test/m1.png",
          "mediaUrls": [
            "https://x.test/m1.png",
          ],
          "replyToCurrent": undefined,
          "replyToId": undefined,
          "replyToTag": false,
          "text": "",
        },
        {
          "audioAsVoice": true,
          "mediaUrl": "https://x.test/m2.png",
          "mediaUrls": [
            "https://x.test/m2.png",
          ],
          "replyToCurrent": undefined,
          "replyToId": "444",
          "replyToTag": true,
          "text": "hi",
        },
        {
          "audioAsVoice": false,
          "btw": {
            "question": "what changed?",
          },
          "mediaUrl": undefined,
          "mediaUrls": undefined,
          "replyToCurrent": undefined,
          "replyToId": undefined,
          "replyToTag": false,
          "text": "BTW
      Question: what changed?

      headline",
        },
        {
          "audioAsVoice": false,
          "channelData": {
            "mode": "custom",
          },
          "mediaUrl": undefined,
          "mediaUrls": undefined,
          "replyToCurrent": undefined,
          "replyToId": undefined,
          "replyToTag": false,
          "text": "",
        },
      ]
    `);
  });

  it("keeps renderable channel-data payloads and reply-to-current markers", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        {
          text: "[[reply_to_current]]",
          channelData: { line: { flexMessage: { altText: "Card", contents: {} } } },
        },
      ]),
    ).toEqual([
      {
        text: "",
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToCurrent: true,
        replyToTag: true,
        audioAsVoice: false,
        channelData: { line: { flexMessage: { altText: "Card", contents: {} } } },
      },
    ]);
  });
});

describe("normalizeOutboundPayloadsForJson", () => {
  function cloneReplyPayloads(
    input: Parameters<typeof normalizeOutboundPayloadsForJson>[0],
  ): ReplyPayload[] {
    return input.map((payload) =>
      "mediaUrls" in payload
        ? ({
            ...payload,
            mediaUrls: payload.mediaUrls ? [...payload.mediaUrls] : undefined,
          } as ReplyPayload)
        : ({ ...payload } as ReplyPayload),
    );
  }

  it.each(
    typedCases<{
      name: string;
      input: Parameters<typeof normalizeOutboundPayloadsForJson>[0];
      expected: ReturnType<typeof normalizeOutboundPayloadsForJson>;
    }>([
      {
        name: "text + media variants",
        input: [
          { text: "hi" },
          { text: "photo", mediaUrl: "https://x.test/a.jpg", audioAsVoice: true },
          { text: "multi", mediaUrls: ["https://x.test/1.png"] },
        ],
        expected: [
          {
            text: "hi",
            mediaUrl: null,
            mediaUrls: undefined,
            audioAsVoice: undefined,
            channelData: undefined,
          },
          {
            text: "photo",
            mediaUrl: "https://x.test/a.jpg",
            mediaUrls: ["https://x.test/a.jpg"],
            audioAsVoice: true,
            channelData: undefined,
          },
          {
            text: "multi",
            mediaUrl: null,
            mediaUrls: ["https://x.test/1.png"],
            audioAsVoice: undefined,
            channelData: undefined,
          },
        ],
      },
      {
        name: "MEDIA directive extraction",
        input: [
          {
            text: "MEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
          },
        ],
        expected: [
          {
            text: "",
            mediaUrl: null,
            mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
            audioAsVoice: undefined,
            channelData: undefined,
          },
        ],
      },
    ]),
  )("$name", ({ input, expected }) => {
    expect(normalizeOutboundPayloadsForJson(cloneReplyPayloads(input))).toEqual(expected);
  });

  it("suppresses reasoning payloads during JSON normalization", () => {
    expect(
      normalizeOutboundPayloadsForJson([
        { text: "Reasoning:\n_step_", isReasoning: true },
        { text: "final answer" },
      ]),
    ).toEqual([
      { text: "final answer", mediaUrl: null, mediaUrls: undefined, audioAsVoice: undefined },
    ]);
  });
});

describe("normalizeOutboundPayloads", () => {
  it("keeps channelData-only payloads", () => {
    const channelData = { line: { flexMessage: { altText: "Card", contents: {} } } };
    expect(normalizeOutboundPayloads([{ channelData }])).toEqual([
      { text: "", mediaUrls: [], channelData },
    ]);
  });

  it("suppresses reasoning payloads during runtime normalization", () => {
    expect(
      normalizeOutboundPayloads([
        { text: "Reasoning:\n_step_", isReasoning: true },
        { text: "final answer" },
      ]),
    ).toEqual([{ text: "final answer", mediaUrls: [] }]);
  });

  it("formats BTW replies prominently for external delivery", () => {
    expect(
      normalizeOutboundPayloads([
        {
          text: "323",
          btw: { question: "what is 17 * 19?" },
        },
      ]),
    ).toEqual([{ text: "BTW\nQuestion: what is 17 * 19?\n\n323", mediaUrls: [] }]);
  });

  it("keeps delivery and mirror projections aligned", () => {
    const payloads: ReplyPayload[] = [
      { text: "Hello" },
      { text: "MEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png" },
      { text: '{"action":"NO_REPLY"}' },
      { text: "NO_REPLY", mediaUrl: "https://x.test/c.png" },
    ];

    const deliveryProjection = normalizeOutboundPayloads(payloads);
    const mirrorProjection = resolveMirrorProjection(payloads);

    expect(mirrorProjection.text).toBe(
      deliveryProjection
        .map((payload) => payload.text)
        .filter((text) => Boolean(text))
        .join("\n"),
    );
    expect(mirrorProjection.mediaUrls).toEqual(
      deliveryProjection.flatMap((payload) => payload.mediaUrls),
    );
  });
});

describe("OutboundPayloadPlan projections", () => {
  const matrix: ReplyPayload[] = [
    { text: "hello" },
    { text: "NO_REPLY" },
    { text: "NO_REPLY", mediaUrl: "https://x.test/1.png" },
    { text: "MEDIA:https://x.test/2.png\nworld" },
    { text: '{"action":"NO_REPLY","note":"keep"}' },
    { text: "reasoning", isReasoning: true },
    { text: " \n", channelData: { mode: "flex" } },
  ];

  it("matches normalizeReplyPayloadsForDelivery", () => {
    const plan = createOutboundPayloadPlan(matrix);
    expect(projectOutboundPayloadPlanForDelivery(plan)).toEqual(
      normalizeReplyPayloadsForDelivery(matrix),
    );
  });

  it("matches normalizeOutboundPayloads", () => {
    const plan = createOutboundPayloadPlan(matrix);
    expect(projectOutboundPayloadPlanForOutbound(plan)).toEqual(normalizeOutboundPayloads(matrix));
  });

  it("matches normalizeOutboundPayloadsForJson", () => {
    const plan = createOutboundPayloadPlan(matrix);
    expect(projectOutboundPayloadPlanForJson(plan)).toEqual(
      normalizeOutboundPayloadsForJson(matrix),
    );
  });

  it("matches mirror projection behavior", () => {
    const plan = createOutboundPayloadPlan(matrix);
    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual(resolveMirrorProjection(matrix));
  });

  it("keeps markdown images as text unless extraction is enabled", () => {
    const input = "Tech: ![Node.js](https://img.shields.io/badge/Node.js-339933)";

    expect(
      projectOutboundPayloadPlanForDelivery(createOutboundPayloadPlan([{ text: input }])),
    ).toEqual([
      {
        text: input,
        mediaUrl: undefined,
        mediaUrls: undefined,
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });

  it("extracts markdown images when the outbound channel opts in", () => {
    const input = "Chart ![chart](https://example.com/chart.png) now";

    expect(
      projectOutboundPayloadPlanForDelivery(
        createOutboundPayloadPlan([{ text: input }], { extractMarkdownImages: true }),
      ),
    ).toEqual([
      {
        text: "Chart now",
        mediaUrl: "https://example.com/chart.png",
        mediaUrls: ["https://example.com/chart.png"],
        replyToId: undefined,
        replyToCurrent: undefined,
        replyToTag: false,
        audioAsVoice: false,
      },
    ]);
  });
});

describe("formatOutboundPayloadLog", () => {
  it.each(
    typedCases<{
      name: string;
      input: Parameters<typeof formatOutboundPayloadLog>[0];
      expected: string;
    }>([
      {
        name: "text with media lines",
        input: {
          text: "hello  ",
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        },
        expected: "hello\nMEDIA:https://x.test/a.png\nMEDIA:https://x.test/b.png",
      },
      {
        name: "media only",
        input: {
          text: "",
          mediaUrls: ["https://x.test/a.png"],
        },
        expected: "MEDIA:https://x.test/a.png",
      },
    ]),
  )("$name", ({ input, expected }) => {
    expect(
      formatOutboundPayloadLog({
        ...input,
        mediaUrls: [...input.mediaUrls],
      }),
    ).toBe(expected);
  });
});

describe("summarizeOutboundPayloadForTransport", () => {
  it("keeps visible text as channel text and does not expose hook-only content", () => {
    const summary = summarizeOutboundPayloadForTransport({
      text: "visible",
      spokenText: "hidden transcript",
    });

    expect(summary.text).toBe("visible");
    expect(summary.hookContent).toBeUndefined();
  });

  it("surfaces spokenText only as hook content for audio-only payloads", () => {
    const summary = summarizeOutboundPayloadForTransport({
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
      spokenText: "Hi Ivy, good morning.",
    });

    expect(summary.text).toBe("");
    expect(summary.hookContent).toBe("Hi Ivy, good morning.");
    expect(summary.mediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(summary.audioAsVoice).toBe(true);
  });

  it("ignores blank spokenText", () => {
    const summary = summarizeOutboundPayloadForTransport({
      mediaUrl: "/tmp/reply.opus",
      spokenText: "   ",
    });

    expect(summary.text).toBe("");
    expect(summary.hookContent).toBeUndefined();
  });
});
