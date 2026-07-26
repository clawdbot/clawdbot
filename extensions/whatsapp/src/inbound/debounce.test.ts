import { describe, expect, it } from "vitest";
import { resolveWhatsAppPrimaryInboundMedia } from "./debounce.js";

describe("resolveWhatsAppPrimaryInboundMedia", () => {
  it("prefers a transferable attachment over an earlier metadata-only item", () => {
    const attachment = { path: "/tmp/photo.jpg", type: "image/jpeg" };

    expect(resolveWhatsAppPrimaryInboundMedia([{ kind: "image" }, attachment])).toBe(attachment);
  });

  it("keeps the first item when the batch only contains metadata", () => {
    const metadata = { kind: "image" } as const;

    expect(resolveWhatsAppPrimaryInboundMedia([metadata, { type: "image/jpeg" }])).toBe(metadata);
  });
});
