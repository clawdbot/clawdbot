import { describe, expect, it } from "vitest";
import {
  parseManifest,
  serializeManifest,
  updateManifestHeightMode,
} from "./sqlite-board-codec.js";

describe("board widget manifest codec", () => {
  it("round-trips presentation and height mode", () => {
    const serialized = serializeManifest(undefined, "none", undefined, {
      presentation: "full-bleed",
      heightMode: "auto",
    });
    expect(parseManifest(serialized)).toMatchObject({
      presentation: "full-bleed",
      heightMode: "auto",
    });
    expect(parseManifest(updateManifestHeightMode(serialized, "fixed"))).toMatchObject({
      presentation: "full-bleed",
      heightMode: "fixed",
    });
  });

  it("ignores invalid persisted frame preferences", () => {
    expect(
      parseManifest(JSON.stringify({ presentation: "floating", heightMode: "elastic" })),
    ).toEqual({});
  });
});
