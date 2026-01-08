import { describe, expect, it } from "vitest";
import { buildInboundMediaNote } from "./media-note.js";

describe("buildInboundMediaNote", () => {
  it("formats single MediaPath as a media note", () => {
    const note = buildInboundMediaNote({
      MediaPath: "/tmp/a.png",
      MediaType: "image/png",
      MediaUrl: "/tmp/a.png",
    });
    expect(note).toBe("[media attached: /tmp/a.png (image/png) | /tmp/a.png]");
  });

  it("formats multiple MediaPaths as numbered media notes", () => {
    const note = buildInboundMediaNote({
      MediaPaths: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
      MediaUrls: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
    });
    expect(note).toBe(
      [
        "[media attached: 3 files]",
        "[media attached 1/3: /tmp/a.png | /tmp/a.png]",
        "[media attached 2/3: /tmp/b.png | /tmp/b.png]",
        "[media attached 3/3: /tmp/c.png | /tmp/c.png]",
      ].join("\n"),
    );
  });
});
