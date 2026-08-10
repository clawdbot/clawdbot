import { describe, expect, it } from "vitest";
import { normalizeMediaReferenceForComparison } from "./media-reference-comparison.js";

describe("normalizeMediaReferenceForComparison", () => {
  it("matches encoded file URLs with equivalent absolute paths", () => {
    expect(normalizeMediaReferenceForComparison("file:///tmp/generated%20image.png")).toBe(
      normalizeMediaReferenceForComparison("/tmp/generated image.png"),
    );
  });

  it("keeps parent segments distinct without resolving filesystem identity", () => {
    expect(normalizeMediaReferenceForComparison("/tmp/output/../generated.png")).toBe(
      "/tmp/output/../generated.png",
    );
  });

  it("applies URL parent-segment semantics before filesystem comparison", () => {
    expect(normalizeMediaReferenceForComparison("file:///tmp/output/../generated.png")).toBe(
      normalizeMediaReferenceForComparison("/tmp/generated.png"),
    );
    expect(normalizeMediaReferenceForComparison("file:///tmp/output/%2e%2e/generated.png")).toBe(
      normalizeMediaReferenceForComparison("/tmp/generated.png"),
    );
  });

  it("normalizes safe absolute path syntax symmetrically", () => {
    expect(normalizeMediaReferenceForComparison("/tmp/output/./generated.png")).toBe(
      normalizeMediaReferenceForComparison("file:///tmp/output/./generated.png"),
    );
  });

  it("preserves remote and relative references after trimming", () => {
    expect(normalizeMediaReferenceForComparison(" https://example.test/a/../b.png ")).toBe(
      "https://example.test/a/../b.png",
    );
    expect(normalizeMediaReferenceForComparison("./output/../generated.png")).toBe(
      "./output/../generated.png",
    );
    expect(normalizeMediaReferenceForComparison("file://server/share.png")).not.toBe(
      normalizeMediaReferenceForComparison("server/share.png"),
    );
    expect(normalizeMediaReferenceForComparison("//cdn.example/share.png")).toBe(
      "//cdn.example/share.png",
    );
    expect(normalizeMediaReferenceForComparison("//cdn.example/share.png")).not.toBe(
      normalizeMediaReferenceForComparison("/cdn.example/share.png"),
    );
    expect(normalizeMediaReferenceForComparison("file:////cdn.example/share.png")).not.toBe(
      normalizeMediaReferenceForComparison("//cdn.example/share.png"),
    );
    expect(normalizeMediaReferenceForComparison("file:////cdn.example/share.png")).not.toBe(
      normalizeMediaReferenceForComparison("/cdn.example/share.png"),
    );
    expect(normalizeMediaReferenceForComparison("file:////cdn.example/a//share.png")).toBe(
      normalizeMediaReferenceForComparison("file:////cdn.example/a/share.png"),
    );
  });

  it("keeps malformed local file URLs comparable with their paths", () => {
    expect(normalizeMediaReferenceForComparison("file:///tmp/100%.png")).toBe(
      normalizeMediaReferenceForComparison("/tmp/100%.png"),
    );
    expect(normalizeMediaReferenceForComparison("file:///tmp/link/../asset%.png")).toBe(
      "/tmp/link/../asset%.png",
    );
  });
});
