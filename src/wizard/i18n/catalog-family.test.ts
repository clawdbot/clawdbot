import { describe, expect, it } from "vitest";
import { catalogFamily, optionalCatalogFamily } from "./catalog-family.js";

describe("catalogFamily", () => {
  it("requires an authored family", () => {
    expect(() => catalogFamily({}, "wizard.missing")).toThrow(
      "catalog has no messages under wizard.missing",
    );
  });

  it("allows a generated family to lag its reviewed English source", () => {
    expect(optionalCatalogFamily({}, "wizard.pending")).toEqual({});
    expect(
      optionalCatalogFamily(
        {
          "wizard.pending.stale": "Stale translation",
          "wizard.pending.title": "Translated title",
          "wizard.other.title": "Other title",
        },
        "wizard.pending",
        {
          sourceMessages: {
            "wizard.pending.new": "New source",
            "wizard.pending.stale": "Current source",
            "wizard.pending.title": "Source title",
          },
          translatedSourceMessages: {
            "wizard.pending.stale": "Old source",
            "wizard.pending.title": "Source title",
          },
        },
      ),
    ).toEqual({
      new: "New source",
      stale: "Current source",
      title: "Translated title",
    });
  });
});
