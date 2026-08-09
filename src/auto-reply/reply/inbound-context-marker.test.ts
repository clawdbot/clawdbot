/** Verifies the hand-maintained marker copies stay equal to the core constant. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { INBOUND_CONTEXT_MARKER, markInboundContextLabel } from "./inbound-context-marker.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("inbound context marker", () => {
  it("appends the marker as a space-separated suffix", () => {
    expect(markInboundContextLabel("Sender:")).toBe(`Sender: ${INBOUND_CONTEXT_MARKER}`);
  });

  // The two copies below cannot import core (plugin boundary / different language). Drift is silent —
  // a mismatched copy simply stops recognizing headers — so pin it here instead.
  it("matches the memory-lancedb copy", () => {
    expect(readRepoFile("extensions/memory-lancedb/memory-capture-sanitization.ts")).toContain(
      INBOUND_CONTEXT_MARKER,
    );
  });

  it("matches the Swift copy", () => {
    const swift = readRepoFile(
      "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownPreprocessor.swift",
    );
    const declaration = /inboundContextMarker\s*=\s*"([^"]+)"/.exec(swift);
    expect(declaration).not.toBeNull();
    const decoded = (declaration?.[1] ?? "").replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_match, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    );
    expect(decoded).toBe(INBOUND_CONTEXT_MARKER);
  });
});
