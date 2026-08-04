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

  it("round-trips explicit and generated name identity metadata", () => {
    const serialized = serializeManifest(undefined, "none", undefined, undefined, {
      kind: "generated",
      source: "show_widget",
      key: "a".repeat(64),
    });
    expect(parseManifest(serialized)).toMatchObject({
      nameIdentity: { kind: "generated", source: "show_widget", key: "a".repeat(64) },
    });
    expect(
      parseManifest(
        serializeManifest(undefined, "none", undefined, undefined, { kind: "explicit" }),
      ),
    ).toMatchObject({ nameIdentity: { kind: "explicit" } });
    expect(
      parseManifest(
        JSON.stringify({
          nameIdentity: { kind: "generated", source: "show_widget", key: "short" },
        }),
      ),
    ).toEqual({ nameIdentityInvalid: true });
  });
});
