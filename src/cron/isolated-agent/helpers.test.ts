import { describe, expect, it } from "vitest";
import {
  isHeartbeatOnlyResponse,
  pickDeliverablePayloads,
  pickLastDeliverablePayload,
  pickLastNonEmptyTextFromPayloads,
  pickSummaryFromPayloads,
} from "./helpers.js";

type TextPayload = { text?: string | undefined; isError?: boolean | undefined };

const textPayloadPickerCases: Array<{
  name: string;
  pick: (payloads: TextPayload[]) => string | undefined;
  payloads: TextPayload[];
  expected: string | undefined;
}> = [
  {
    name: "summary picks real text over error payload",
    pick: pickSummaryFromPayloads,
    payloads: [
      { text: "Here is your summary" },
      { text: "Tool error: rate limited", isError: true },
    ],
    expected: "Here is your summary",
  },
  {
    name: "summary falls back to error payload when no real text exists",
    pick: pickSummaryFromPayloads,
    payloads: [{ text: "Tool error: rate limited", isError: true }],
    expected: "Tool error: rate limited",
  },
  {
    name: "summary returns undefined for empty payloads",
    pick: pickSummaryFromPayloads,
    payloads: [],
    expected: undefined,
  },
  {
    name: "summary treats isError: undefined as non-error",
    pick: pickSummaryFromPayloads,
    payloads: [
      { text: "normal text", isError: undefined },
      { text: "error text", isError: true },
    ],
    expected: "normal text",
  },
  {
    name: "last non-empty text picks real text over error payload",
    pick: pickLastNonEmptyTextFromPayloads,
    payloads: [{ text: "Real output" }, { text: "Service error", isError: true }],
    expected: "Real output",
  },
  {
    name: "last non-empty text falls back to error payload when no real text exists",
    pick: pickLastNonEmptyTextFromPayloads,
    payloads: [{ text: "Service error", isError: true }],
    expected: "Service error",
  },
  {
    name: "last non-empty text returns undefined for empty payloads",
    pick: pickLastNonEmptyTextFromPayloads,
    payloads: [],
    expected: undefined,
  },
  {
    name: "last non-empty text treats isError: undefined as non-error",
    pick: pickLastNonEmptyTextFromPayloads,
    payloads: [
      { text: "good", isError: undefined },
      { text: "bad", isError: true },
    ],
    expected: "good",
  },
];

describe("text payload pickers", () => {
  it.each(textPayloadPickerCases)("$name", ({ pick, payloads, expected }) => {
    expect(pick(payloads)).toBe(expected);
  });
});

describe("pickLastDeliverablePayload", () => {
  it("picks real payload over error payload", () => {
    const real = { text: "Delivered content" };
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([real, error])).toBe(real);
  });

  it("falls back to error payload when no real payload exists", () => {
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([error])).toBe(error);
  });

  it("returns undefined for empty payloads", () => {
    expect(pickLastDeliverablePayload([])).toBeUndefined();
  });

  it("picks media payload over error text payload", () => {
    const media = { mediaUrl: "https://example.com/img.png" };
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([media, error])).toBe(media);
  });

  it("picks presentation-only payload over error text payload", () => {
    const presentation = {
      presentation: {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Ack", value: "ack" }] }],
      },
    };
    const error = { text: "Error warning", isError: true as const };
    expect(pickLastDeliverablePayload([presentation, error])).toBe(presentation);
  });

  it("treats isError: undefined as non-error", () => {
    const normal = { text: "ok", isError: undefined };
    const error = { text: "bad", isError: true as const };
    expect(pickLastDeliverablePayload([normal, error])).toBe(normal);
  });
});

describe("pickDeliverablePayloads", () => {
  it("preserves all successful deliverable payloads", () => {
    const payloads = [
      { text: "line 1" },
      { text: "temporary error", isError: true as const },
      { text: "line 2" },
    ];

    expect(pickDeliverablePayloads(payloads)).toEqual([{ text: "line 1" }, { text: "line 2" }]);
  });

  it("preserves rich-only successful deliverable payloads", () => {
    const presentation = {
      presentation: {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "Ack", value: "ack" }] }],
      },
    };

    expect(pickDeliverablePayloads([presentation])).toEqual([presentation]);
  });

  it("returns only the last error payload when all payloads are errors", () => {
    const payloads = [
      { text: "first error", isError: true as const },
      { text: "last error", isError: true as const },
    ];

    expect(pickDeliverablePayloads(payloads)).toEqual([{ text: "last error", isError: true }]);
  });
});

describe("isHeartbeatOnlyResponse", () => {
  const ACK_MAX = 300;

  it("returns true for empty payloads", () => {
    expect(isHeartbeatOnlyResponse([], ACK_MAX)).toBe(true);
  });

  it("returns true for a single HEARTBEAT_OK payload", () => {
    expect(isHeartbeatOnlyResponse([{ text: "HEARTBEAT_OK" }], ACK_MAX)).toBe(true);
  });

  it("returns false for a single non-heartbeat payload", () => {
    expect(isHeartbeatOnlyResponse([{ text: "Something important happened" }], ACK_MAX)).toBe(
      false,
    );
  });

  it("returns true when multiple payloads include narration followed by HEARTBEAT_OK", () => {
    // Agent narrates its work then signals nothing needs attention.
    expect(
      isHeartbeatOnlyResponse(
        [
          { text: "It's 12:49 AM — quiet hours. Let me run the checks quickly." },
          { text: "Emails: Just 2 calendar invites. Not urgent." },
          { text: "HEARTBEAT_OK" },
        ],
        ACK_MAX,
      ),
    ).toBe(true);
  });

  it("returns false when media is present even with HEARTBEAT_OK text", () => {
    expect(
      isHeartbeatOnlyResponse(
        [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/img.png" }],
        ACK_MAX,
      ),
    ).toBe(false);
  });

  it("returns false when rich content is present even with HEARTBEAT_OK text", () => {
    expect(
      isHeartbeatOnlyResponse(
        [
          {
            text: "HEARTBEAT_OK",
            presentation: {
              blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
            },
          },
        ],
        ACK_MAX,
      ),
    ).toBe(false);
  });

  it("returns false when media is in a different payload than HEARTBEAT_OK", () => {
    expect(
      isHeartbeatOnlyResponse(
        [
          { text: "HEARTBEAT_OK" },
          { text: "Here's an image", mediaUrl: "https://example.com/img.png" },
        ],
        ACK_MAX,
      ),
    ).toBe(false);
  });

  it("returns false when no payload contains HEARTBEAT_OK", () => {
    expect(
      isHeartbeatOnlyResponse(
        [{ text: "Checked emails — found 3 urgent messages from your manager." }],
        ACK_MAX,
      ),
    ).toBe(false);
  });
});
