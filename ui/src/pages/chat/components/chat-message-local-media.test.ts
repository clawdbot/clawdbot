// Control UI tests cover local media preview path policy.
import { describe, expect, it } from "vitest";
import { isLocalAttachmentPreviewAllowed } from "./chat-message-local-media.ts";

describe("isLocalAttachmentPreviewAllowed", () => {
  it("keeps literal $ patterns in home when expanding tilde sources", () => {
    const roots = ["/home/us$&r/media"];
    expect(isLocalAttachmentPreviewAllowed("~/media/report.png", roots)).toBe(true);
    expect(isLocalAttachmentPreviewAllowed("~/elsewhere/report.png", roots)).toBe(false);
  });
});
