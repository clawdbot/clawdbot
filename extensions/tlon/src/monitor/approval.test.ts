// Tlon tests cover approval plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const cryptoMocks = vi.hoisted(() => ({
  randomBytes: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomBytes: cryptoMocks.randomBytes,
}));

let createPendingApproval: typeof import("./approval.js").createPendingApproval;
let formatApprovalRequest: typeof import("./approval.js").formatApprovalRequest;

beforeAll(async () => {
  ({ createPendingApproval, formatApprovalRequest } = await import("./approval.js"));
});

beforeEach(() => {
  cryptoMocks.randomBytes.mockReset();
});

describe("createPendingApproval ID", () => {
  it("uses secure hex entropy while preserving the ID format", () => {
    cryptoMocks.randomBytes.mockReturnValueOnce(Buffer.from("a1b2c3", "hex"));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_717_171_717_171);

    try {
      const approval = createPendingApproval({ type: "dm", requestingShip: "~sampel-palnet" });
      expect(approval.id).toBe("dm-1717171717171-a1b2c3");
      expect(cryptoMocks.randomBytes).toHaveBeenCalledWith(3);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("approval preview UTF-16 boundary safety", () => {
  const LONE_SURROGATE = /[\uD800-\uDFFF]/;

  // U+1F600 is two UTF-16 code units.
  // Place it so the high surrogate lands exactly at the 100-unit cap.
  // "a".repeat(99) = 99 units, then \uD83D at index 99 splits the pair.
  const textWithEmojiAtBoundary = "a".repeat(99) + "\uD83D\uDE00tail";

  it("DM path: messagePreview stored in PendingApproval is free of lone surrogates", () => {
    cryptoMocks.randomBytes.mockReturnValue(Buffer.from("aabbcc", "hex"));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    try {
      const approval = createPendingApproval({
        type: "dm",
        requestingShip: "~sampel-palnet",
        messagePreview: textWithEmojiAtBoundary,
      });
      expect(LONE_SURROGATE.test(approval.messagePreview ?? "")).toBe(false);
      expect(approval.messagePreview).not.toContain("\uD83D");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("channel path: messagePreview stored in PendingApproval is free of lone surrogates", () => {
    cryptoMocks.randomBytes.mockReturnValue(Buffer.from("aabbcc", "hex"));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    try {
      const approval = createPendingApproval({
        type: "channel",
        requestingShip: "~sampel-palnet",
        channelNest: "chat/~sampel/test",
        messagePreview: textWithEmojiAtBoundary,
      });
      expect(LONE_SURROGATE.test(approval.messagePreview ?? "")).toBe(false);
      expect(approval.messagePreview).not.toContain("\uD83D");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("formatApprovalRequest renders well-formed UTF-16 in the owner notification", () => {
    cryptoMocks.randomBytes.mockReturnValue(Buffer.from("aabbcc", "hex"));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    try {
      const approval = createPendingApproval({
        type: "dm",
        requestingShip: "~sampel-palnet",
        messagePreview: textWithEmojiAtBoundary,
      });
      const rendered = formatApprovalRequest(approval);
      expect(LONE_SURROGATE.test(rendered)).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
