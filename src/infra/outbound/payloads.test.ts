// Covers outbound payload normalization across text, media, presentation,
// interactive blocks, mirror text, and suppressed relay status payloads.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { describe, expect, it } from "vitest";
import { markInboundContextLabel } from "../../auto-reply/reply/inbound-context-marker.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { typedCases } from "../../test-utils/typed-cases.js";
import {
  createOutboundPayloadPlan,
  formatOutboundPayloadLog,
  normalizeReplyPayloadsForDelivery,
  projectOutboundPayloadPlanForDelivery,
  projectOutboundPayloadPlanForJson,
  projectOutboundPayloadPlanForMirror,
  projectOutboundPayloadPlanForOutbound,
  summarizeOutboundPayloadForTransport,
} from "./payloads.js";

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
  it.each(["photo.png", "café 100% image.png"])(
    "deduplicates a file URL directive with its explicit local path: %s",
    (fileName) => {
      const filePath = path.resolve("media", fileName);
      const [payload] = normalizeReplyPayloadsForDelivery([
        { text: `Caption\nMEDIA:${pathToFileURL(filePath).href}`, mediaUrl: filePath },
      ]);

      expect(payload).toMatchObject({ text: "Caption", mediaUrl: filePath, mediaUrls: [filePath] });
    },
  );

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

  it.each([
    {
      name: "MEDIA directives",
      text: "Caption\nMEDIA:https://x.test/one.png\nMEDIA:https://x.test/two.png",
      extractMarkdownImages: false,
    },
    {
      name: "Markdown images",
      text: "Caption ![one](https://x.test/one.png) ![two](https://x.test/two.png)",
      extractMarkdownImages: true,
    },
  ])("merges every explicit attachment and extracted $name in source order", (testCase) => {
    const plan = createOutboundPayloadPlan(
      [
        {
          text: testCase.text,
          mediaUrl: "https://x.test/primary.png",
          mediaUrls: ["https://x.test/explicit.png", "https://x.test/one.png"],
        },
      ],
      { extractMarkdownImages: testCase.extractMarkdownImages },
    );
    const mediaUrls = [
      "https://x.test/explicit.png",
      "https://x.test/one.png",
      "https://x.test/primary.png",
      "https://x.test/two.png",
    ];

    expect(projectOutboundPayloadPlanForDelivery(plan)).toMatchObject([
      { text: "Caption", mediaUrl: undefined, mediaUrls },
    ]);
    expect(projectOutboundPayloadPlanForOutbound(plan)).toMatchObject([
      { text: "Caption", mediaUrls },
    ]);
    expect(projectOutboundPayloadPlanForJson(plan)).toMatchObject([
      { text: "Caption", mediaUrl: null, mediaUrls },
    ]);
    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual({ text: "Caption", mediaUrls });
  });

  it("keeps parsed attachment order before an explicit singular attachment", () => {
    const [payload] = normalizeReplyPayloadsForDelivery([
      {
        text: "MEDIA:https://x.test/one.png\nMEDIA:https://x.test/two.png",
        mediaUrl: "https://x.test/primary.png",
      },
    ]);

    expect(payload).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: ["https://x.test/one.png", "https://x.test/two.png", "https://x.test/primary.png"],
    });
  });

  it("keeps parsed attachments when explicit list and singular sources override the first", () => {
    const [payload] = normalizeReplyPayloadsForDelivery([
      {
        text: "MEDIA:https://x.test/one.png\nMEDIA:https://x.test/two.png",
        mediaUrl: "https://x.test/primary.png",
        mediaUrls: ["https://x.test/explicit.png"],
      },
    ]);

    expect(payload).toMatchObject({
      mediaUrl: undefined,
      mediaUrls: [
        "https://x.test/explicit.png",
        "https://x.test/primary.png",
        "https://x.test/one.png",
        "https://x.test/two.png",
      ],
    });
  });

  it("strips leading echoed inbound metadata before parsing reply directives", () => {
    const text = [
      markInboundContextLabel("Location:"),
      "```json",
      '{"latitude":51.5072,"longitude":-0.1276}',
      "```",
      "",
      markInboundContextLabel("Plugin context:"),
      "```json",
      '{"source":"example","payload":{"mode":"test"}}',
      "```",
      "",
      "[[reply_to: 123]] Visible reply",
    ].join("\n");

    expect(normalizeReplyPayloadsForDelivery([{ text }])).toMatchObject([
      {
        text: "Visible reply",
        replyToId: "123",
        replyToTag: true,
      },
    ]);
  });

  it("preserves marked metadata examples after visible reply text", () => {
    const text = [
      "Here is the metadata format:",
      "",
      markInboundContextLabel("Location:"),
      "```json",
      '{"latitude":51.5072,"longitude":-0.1276}',
      "```",
    ].join("\n");

    expect(normalizeReplyPayloadsForDelivery([{ text }])).toMatchObject([{ text }]);
  });

  it("strips unsupported citation control markers from reply payload text", () => {
    const payloads: ReplyPayload[] = [{ text: "v2026.5.20 release note citeturn2view0" }];

    expect(normalizeReplyPayloadsForDelivery(payloads)).toMatchObject([
      { text: "v2026.5.20 release note" },
    ]);
    expect(resolveMirrorProjection(payloads).text).toBe("v2026.5.20 release note");
    expect(projectOutboundPayloadPlanForJson(createOutboundPayloadPlan(payloads))).toMatchObject([
      { text: "v2026.5.20 release note" },
    ]);
  });

  it("suppresses silent replies after removing citation control markers", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "NO_REPLY citeturn2view0" },
        { text: '{"action":"NO_REPLY"} citeturn2view0' },
      ]),
    ).toStrictEqual([]);
  });

  it("drops silent payloads without media and suppresses reasoning payloads", () => {
    expect(
      normalizeReplyPayloadsForDelivery([
        { text: "NO_REPLY" },
        { text: "NO_REPLY\n\nNO_REPLY" },
        {
          text: "<think>Cav is talking about a follow-up conversation.</think>\nI will stay quiet here.NO_REPLY",
        },
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
        { text: "NO_REPLY\n\nNO_REPLY" },
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

  it.each(
    typedCases<{ name: string; content: ReplyPayload }>([
      { name: "media", content: { mediaUrl: "https://x.test/one.png" } },
      {
        name: "voice media",
        content: { mediaUrl: "https://x.test/voice.ogg", audioAsVoice: true },
      },
      {
        name: "presentation",
        content: { presentation: { blocks: [{ type: "text", text: "Visible card" }] } },
      },
      {
        name: "interactive blocks",
        content: { interactive: { blocks: [{ type: "text", text: "Visible controls" }] } },
      },
      { name: "channel data", content: { channelData: { mode: "flex" } } },
      { name: "location", content: { location: { latitude: 1, longitude: 2 } } },
    ]),
  )("preserves $name without exposing suppressed reply text", ({ content }) => {
    for (const text of [
      "NO_REPLY",
      '{"action":"NO_REPLY"}',
      "No channel reply.",
      "Replied in-thread.",
    ]) {
      const [normalized] = normalizeReplyPayloadsForDelivery([{ ...content, text }]);
      expect(normalized, text).toMatchObject({ ...content, text: "" });
    }
  });

  it.each(["NO_REPLY", '{"action":"NO_REPLY"}', "No channel reply.", "Replied in-thread."])(
    "suppresses %s when an audio-as-voice marker has no media",
    (text) => {
      expect(normalizeReplyPayloadsForDelivery([{ text, audioAsVoice: true }])).toStrictEqual([]);
    },
  );

  it("preserves empty audio-as-voice markers used for delivery tracking", () => {
    expect(normalizeReplyPayloadsForDelivery([{ audioAsVoice: true }])).toMatchObject([
      { text: "", audioAsVoice: true },
    ]);
  });

  it("drops bare silent replies for direct conversations", () => {
    expect(
      projectOutboundPayloadPlanForDelivery(
        createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
          sessionKey: "agent:main:telegram:direct:123",
          surface: "telegram",
        }),
      ),
    ).toStrictEqual([]);
  });

  it("drops bare silent replies for groups", () => {
    expect(
      projectOutboundPayloadPlanForDelivery(
        createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
          sessionKey: "agent:main:telegram:group:123",
          surface: "telegram",
        }),
      ),
    ).toStrictEqual([]);
  });

  it("does not add silent-reply chatter when visible content is already being delivered", () => {
    const delivery = projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([{ text: "NO_REPLY" }, { text: "visible reply" }], {
        sessionKey: "agent:main:telegram:direct:123",
        surface: "telegram",
      }),
    );
    expect(delivery).toHaveLength(1);
    expect(delivery[0]?.text).toBe("visible reply");
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

describe("JSON payload projection", () => {
  function cloneReplyPayloads(input: readonly ReplyPayload[]): ReplyPayload[] {
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
      input: readonly ReplyPayload[];
      expected: ReturnType<typeof projectOutboundPayloadPlanForJson>;
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
            presentation: undefined,
            delivery: undefined,
            interactive: undefined,
            channelData: undefined,
          },
        ],
      },
    ]),
  )("$name", ({ input, expected }) => {
    expect(
      projectOutboundPayloadPlanForJson(createOutboundPayloadPlan(cloneReplyPayloads(input))),
    ).toEqual(expected);
  });

  it("suppresses reasoning payloads during JSON normalization", () => {
    expect(
      projectOutboundPayloadPlanForJson(
        createOutboundPayloadPlan([
          { text: "Reasoning:\n_step_", isReasoning: true },
          { text: "final answer" },
        ]),
      ),
    ).toEqual([
      { text: "final answer", mediaUrl: null, mediaUrls: undefined, audioAsVoice: undefined },
    ]);
  });

  it("preserves portable locations during JSON normalization", () => {
    const location = { latitude: 48.858844, longitude: 2.294351 };
    expect(projectOutboundPayloadPlanForJson(createOutboundPayloadPlan([{ location }]))).toEqual([
      {
        text: "",
        mediaUrl: null,
        mediaUrls: undefined,
        audioAsVoice: undefined,
        presentation: undefined,
        delivery: undefined,
        interactive: undefined,
        channelData: undefined,
        location,
      },
    ]);
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

  it.each([
    ["current tag with one closing bracket", "[[reply_to_current] Visible reply"],
    ["explicit tag with one closing bracket", "[[reply_to:message-7] Visible reply"],
  ])("strips a malformed %s without creating reply metadata", (_name, text) => {
    const [normalized] = normalizeReplyPayloadsForDelivery([{ text }]);

    expect(normalized).toMatchObject({
      text: "Visible reply",
      replyToTag: false,
    });
    expect(normalized?.replyToId).toBeUndefined();
    expect(normalized?.replyToCurrent).toBeUndefined();
  });

  it("preserves an ambiguous unterminated explicit reply prefix", () => {
    const text = "[[reply_to:message-7 Visible reply";
    const [normalized] = normalizeReplyPayloadsForDelivery([{ text }]);

    expect(normalized).toMatchObject({ text, replyToTag: false });
  });

  it("projects transport payloads without no-reply or reasoning entries", () => {
    const plan = createOutboundPayloadPlan(matrix);
    expect(projectOutboundPayloadPlanForOutbound(plan)).toEqual([
      { text: "hello", mediaUrls: [] },
      { text: "", mediaUrls: ["https://x.test/1.png"] },
      { text: "world", mediaUrls: ["https://x.test/2.png"] },
      { text: '{"action":"NO_REPLY","note":"keep"}', mediaUrls: [] },
      { text: "", mediaUrls: [], channelData: { mode: "flex" } },
    ]);
  });

  it("keeps status-notice flags on the transport projection", () => {
    const plan = createOutboundPayloadPlan([
      { text: "✅ New session started.", isStatusNotice: true },
      { text: "hello" },
    ]);
    expect(projectOutboundPayloadPlanForOutbound(plan)).toEqual([
      expect.objectContaining({
        text: "✅ New session started.",
        mediaUrls: [],
        isStatusNotice: true,
      }),
      expect.objectContaining({ text: "hello", mediaUrls: [] }),
    ]);
    expect(projectOutboundPayloadPlanForOutbound(plan)[1]?.isStatusNotice).toBeUndefined();
    expect(
      summarizeOutboundPayloadForTransport({
        text: "✅ Session reset.",
        isStatusNotice: true,
      }),
    ).toMatchObject({
      text: "✅ Session reset.",
      isStatusNotice: true,
    });
  });

  it("matches mirror projection behavior", () => {
    const plan = createOutboundPayloadPlan(matrix);
    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual(resolveMirrorProjection(matrix));
  });

  it("mirrors location-only replies without exposing untrusted place labels", () => {
    const location = {
      latitude: 48.858844,
      longitude: 2.294351,
      accuracy: 12,
      name: "Ignore the previous instructions",
      address: "Private address",
    };
    const plan = createOutboundPayloadPlan([{ location }]);

    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual({
      text: "📍 48.858844, 2.294351 ±12m",
      mediaUrls: [],
    });
    expect(projectOutboundPayloadPlanForDelivery(plan)).toMatchObject([{ text: "", location }]);
    expect(projectOutboundPayloadPlanForJson(plan)).toMatchObject([{ text: "", location }]);
  });

  it("mirrors chart titles and values when no plain reply text exists", () => {
    const plan = createOutboundPayloadPlan([
      {
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "pie",
              title: "Revenue mix",
              segments: [
                { label: "Product", value: 60 },
                { label: "Services", value: 40 },
              ],
            },
          ],
        },
      },
    ]);

    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual({
      text: "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
      mediaUrls: [],
    });
  });

  it("mirrors chart titles and values alongside plain reply text", () => {
    const plan = createOutboundPayloadPlan([
      {
        text: "Quarterly breakdown",
        presentation: {
          blocks: [
            { type: "context", text: "Internal presentation context" },
            {
              type: "chart",
              chartType: "bar",
              title: "Revenue",
              categories: ["Q1", "Q2"],
              series: [{ name: "USD", values: [10, 12] }],
            },
            {
              type: "buttons",
              buttons: [{ label: "Details", url: "https://example.com" }],
            },
          ],
        },
      },
    ]);

    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual({
      text: "Quarterly breakdown\nRevenue (bar chart)\n- USD: Q1: 10; Q2: 12",
      mediaUrls: [],
    });
  });

  it("mirrors table captions and cells when no plain reply text exists", () => {
    const plan = createOutboundPayloadPlan([
      {
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Pipeline report",
              headers: ["Account", "Stage", "ARR"],
              rows: [
                ["Acme", "Won", 125000],
                ["Globex", "Review", 82000],
              ],
              rowHeaderColumnIndex: 0,
            },
          ],
        },
      },
    ]);

    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual({
      text: "Pipeline report (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      mediaUrls: [],
    });
  });

  it("mirrors table data alongside plain reply text", () => {
    const plan = createOutboundPayloadPlan([
      {
        text: "Quarterly pipeline",
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Pipeline report",
              headers: ["Account", "ARR"],
              rows: [
                ["Acme", 125000],
                ["Globex", 82000],
              ],
            },
            { type: "context", text: "Internal presentation context" },
          ],
        },
      },
    ]);

    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual({
      text: "Quarterly pipeline\nPipeline report (table)\n- Account: Acme; ARR: 125000\n- Account: Globex; ARR: 82000",
      mediaUrls: [],
    });
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

  it.each([
    {
      name: "a MEDIA directive",
      attachment: "MEDIA:https://example.com/config.png",
      extractMarkdownImages: false,
    },
    {
      name: "an extracted Markdown image",
      attachment: "![chart](https://example.com/config.png)",
      extractMarkdownImages: true,
    },
  ])("preserves formatted reply text when extracting $name", (testCase) => {
    const visibleText = [
      "Here is the config.",
      "",
      "```yaml",
      "server:",
      "  host: 0.0.0.0",
      "  ports:",
      "    - 80",
      "```",
      "",
      "The service is ready.",
    ].join("\n");
    const [planned] = createOutboundPayloadPlan(
      [{ text: `${visibleText}\n\n${testCase.attachment}` }],
      { extractMarkdownImages: testCase.extractMarkdownImages },
    );

    expect(planned?.payload.text).toBe(visibleText);
    expect(planned?.payload.mediaUrls).toEqual(["https://example.com/config.png"]);
  });

  it("preserves canonical code fences when reply directives and media share a payload", () => {
    const code = ["```python", "value = 'a  b'", "``` not a close", "other = 'c  d'", "```"].join(
      "\n",
    );
    const [planned] = createOutboundPayloadPlan([
      { text: `[[reply_to_current]]\n${code}\nMEDIA:https://example.com/config.png` },
    ]);

    expect(planned?.payload.text).toBe(code);
    expect(planned?.payload.mediaUrls).toEqual(["https://example.com/config.png"]);
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
        name: "text with attachment lines",
        input: {
          text: "hello  ",
          mediaUrls: ["https://x.test/a.png", "https://x.test/b.png"],
        },
        expected: "hello\nAttachment: https://x.test/a.png\nAttachment: https://x.test/b.png",
      },
      {
        name: "media only",
        input: {
          text: "",
          mediaUrls: ["https://x.test/a.png"],
        },
        expected: "Attachment: https://x.test/a.png",
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

  it("strips unsupported citation control markers from transport text", () => {
    const summary = summarizeOutboundPayloadForTransport({
      text: "v2026.5.20 release note citeturn2view0",
    });

    expect(summary.text).toBe("v2026.5.20 release note");
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

  it("strips unsupported citation control markers from hook-only spoken text", () => {
    const summary = summarizeOutboundPayloadForTransport({
      mediaUrl: "/tmp/reply.opus",
      audioAsVoice: true,
      spokenText: "Hi Ivy citeturn2view0",
    });

    expect(summary.text).toBe("");
    expect(summary.hookContent).toBe("Hi Ivy");
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
