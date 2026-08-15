// Covers bounded, untrusted channel metadata construction.
import { describe, expect, it } from "vitest";
import { buildChannelMetadata, buildUntrustedChannelMetadata } from "./channel-metadata.js";

function normalizeMarkerIds(value: string): string {
  return value.replace(/id="[a-f0-9]{16}"/g, 'id="<id>"');
}

function wrapExpected(content: string): string {
  return [
    "",
    '<<<EXTERNAL_UNTRUSTED_CONTENT id="<id>">>>',
    "Source: Channel metadata",
    "---",
    content,
    '<<<END_EXTERNAL_UNTRUSTED_CONTENT id="<id>">>>',
  ].join("\n");
}

describe("buildChannelMetadata", () => {
  it("keeps the deprecated SDK alias identical", () => {
    expect(buildUntrustedChannelMetadata).toBe(buildChannelMetadata);
  });

  it("keeps per-entry truncation UTF-16 safe", () => {
    const entryPrefix = "a".repeat(396);
    const result = buildChannelMetadata({
      source: "test",
      label: "Test channel",
      entries: [`${entryPrefix}🎉tail`],
    });

    expect(normalizeMarkerIds(result ?? "")).toBe(
      wrapExpected(`Channel metadata (test)\nTest channel:\n${entryPrefix}...`),
    );
  });

  it("keeps the combined metadata limit UTF-16 safe", () => {
    const header = "Channel metadata (test)\nTest channel:\n";
    const entryPrefix = "short";
    const result = buildChannelMetadata({
      source: "test",
      label: "Test channel",
      entries: [`${entryPrefix}🎉tail`],
      maxChars: header.length + entryPrefix.length + 4,
    });

    expect(normalizeMarkerIds(result ?? "")).toBe(wrapExpected(`${header}${entryPrefix}...`));
  });
});
