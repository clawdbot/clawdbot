import { describe, expect, it } from "vitest";
import {
  buildSuppliedImageSourceIndexes,
  orderSourceIndexedEntries,
  resolveInlineImageFactIndexes,
  resolveProjectedImageSourceIndexes,
} from "./image-source-indexes.js";

describe("resolveProjectedImageSourceIndexes", () => {
  it("maps source slots into projected media order", () => {
    expect(
      resolveProjectedImageSourceIndexes({
        imageSourceMapping: { indexes: [2, undefined, 0], space: "inbound-media" },
        imageOrderLength: 3,
        projectedMediaSourceIndexes: [0, 2],
        projectedMediaLength: 2,
      }),
    ).toEqual({ kind: "mapped", indexes: [1, undefined, 0] });
  });

  it("rejects source indexes absent from the projection", () => {
    expect(
      resolveProjectedImageSourceIndexes({
        imageSourceMapping: { indexes: [1], space: "inbound-media" },
        imageOrderLength: 1,
        projectedMediaSourceIndexes: [0, 2],
        projectedMediaLength: 2,
      }),
    ).toEqual({
      kind: "invalid",
      reason: "Image source index 1 is absent from the media projection",
      indexes: [undefined],
    });
  });

  it("rejects missing or misaligned projection metadata", () => {
    expect(
      resolveProjectedImageSourceIndexes({
        imageSourceMapping: { indexes: [0, 1], space: "inbound-media" },
        imageOrderLength: 1,
        projectedMediaLength: 1,
      }),
    ).toEqual({
      kind: "invalid",
      reason:
        "Queued image source slots and image order must remain aligned; Cannot remap image sources without a declared media projection",
      indexes: [undefined],
    });
    expect(
      resolveProjectedImageSourceIndexes({
        imageSourceMapping: { indexes: [0], space: "inbound-media" },
        imageOrderLength: 1,
        projectedMediaSourceIndexes: [0],
        projectedMediaLength: 2,
      }),
    ).toEqual({
      kind: "invalid",
      reason: "Media projection facts and source indexes must remain aligned",
      indexes: [undefined],
    });
  });

  it("rejects run-media indexes outside the projected media list", () => {
    expect(
      resolveProjectedImageSourceIndexes({
        imageSourceMapping: { indexes: [1], space: "run-media" },
        imageOrderLength: 1,
        projectedMediaLength: 1,
      }),
    ).toEqual({
      kind: "invalid",
      reason: "Run-media image source index 1 is outside the media projection",
      indexes: [undefined],
    });
  });
});

describe("buildSuppliedImageSourceIndexes", () => {
  it("maps offloaded slots into the combined inbound media space", () => {
    expect(
      buildSuppliedImageSourceIndexes({
        imageOrder: ["inline", "offloaded"],
        suppliedMedia: [
          { path: "/tmp/report.pdf", contentType: "application/pdf" },
          { path: "/tmp/photo.png", contentType: "image/png" },
        ],
        sourceOffset: 3,
      }),
    ).toEqual({ kind: "mapped", indexes: [undefined, 4] });
  });

  it("returns an invalid result when offloaded slots and supplied image facts diverge", () => {
    expect(
      buildSuppliedImageSourceIndexes({
        imageOrder: ["offloaded", "offloaded"],
        suppliedMedia: [{ path: "/tmp/photo.png", contentType: "image/png" }],
        sourceOffset: 0,
      }),
    ).toEqual({
      kind: "invalid",
      reason: "Offloaded image slot count 2 does not match supplied image fact count 1",
      indexes: [0, undefined],
    });
  });
});

describe("resolveInlineImageFactIndexes", () => {
  it("selects only inline identities in image payload order", () => {
    expect(
      resolveInlineImageFactIndexes({
        imageOrder: ["offloaded", "inline", "inline"],
        imageSourceIndexes: [2, 0, undefined],
      }),
    ).toEqual([0, null]);
  });
});

describe("orderSourceIndexedEntries", () => {
  it("orders sourced entries without moving unsourced slots", () => {
    const entries = [
      { id: "supplied", sequence: 0 },
      { id: "second-source", sourceIndex: 2, sequence: 1 },
      { id: "first-source", sourceIndex: 0, sequence: 2 },
      { id: "other-supplied", sequence: 3 },
    ];

    expect(orderSourceIndexedEntries(entries).map((entry) => entry.id)).toEqual([
      "supplied",
      "first-source",
      "second-source",
      "other-supplied",
    ]);
  });
});
