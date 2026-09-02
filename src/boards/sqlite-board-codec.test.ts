import { describe, expect, it } from "vitest";
import { parseManifest } from "./sqlite-board-codec.js";

describe("board widget manifest codec", () => {
  it("preserves registered content ownership independently of frame instance metadata", () => {
    expect(
      parseManifest(
        JSON.stringify({ contentOwner: "registered", registeredContentKind: "diagram" }),
      ),
    ).toMatchObject({ contentOwner: "registered", registeredContentKind: "diagram" });
  });

  it.each([
    { contentOwner: "unknown" },
    { contentOwner: "registered" },
    { contentOwner: "registered", registeredContentKind: "Invalid Kind" },
    { contentOwner: "plugin", registeredContentKind: "diagram" },
  ])("rejects invalid explicit widget ownership %j", (manifest) => {
    expect(() => parseManifest(JSON.stringify(manifest))).toThrow(/content ownership/i);
  });

  it("ignores invalid persisted frame preferences", () => {
    expect(
      parseManifest(JSON.stringify({ presentation: "floating", heightMode: "elastic" })),
    ).toEqual({});
  });

  it("flags invalid persisted generated name identity metadata", () => {
    expect(
      parseManifest(
        JSON.stringify({
          nameIdentity: { kind: "generated", source: "show_widget", key: "short" },
        }),
      ),
    ).toEqual({ nameIdentityInvalid: true });
  });
});
