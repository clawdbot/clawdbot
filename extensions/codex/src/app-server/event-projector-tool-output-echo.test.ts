import { describe, expect, it } from "vitest";
import {
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
  toolOutputRawEchoSignature,
} from "./event-projector-tool-output.js";

function proofLine(label: string, value: string | number | boolean): void {
  // Verbatim proof for PR evidence: exercises the production write-site helper.
  process.stdout.write(`[utf16-echo-proof] ${label}=${String(value)}\n`);
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("toolOutputRawEchoSignature", () => {
  it("does not split a surrogate pair at the transcript budget (raw .slice would)", () => {
    // High surrogate of 😀 lands at index 9999; raw slice(0, 10000) keeps it.
    const text = `${"a".repeat(9_999)}\u{1F600}${"a".repeat(400)}`;
    const broken = text.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS);
    expect(hasLoneSurrogate(broken)).toBe(true);
    expect(broken.charCodeAt(broken.length - 1)).toBe(0xd83d);

    const signature = toolOutputRawEchoSignature(text);
    expect(signature).toBeDefined();
    expect(signature!.rawLength).toBe(text.length);
    // Prefer full scalar at the cutoff: no lone surrogate, but keep the emoji so a
    // distinct same-length assistant reply cannot falsely match.
    expect(hasLoneSurrogate(signature!.rawPrefix)).toBe(false);
    expect(signature!.rawPrefix.endsWith("\u{1F600}")).toBe(true);
    expect(signature!.rawPrefix).toBe(`${"a".repeat(9_999)}\u{1F600}`);
    expect(signature!.rawPrefix.length).toBe(TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS + 1);

    proofLine("write_site", "toolOutputRawEchoSignature.rawPrefix");
    proofLine("budget", TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS);
    proofLine("broken_slice_len", broken.length);
    proofLine("broken_slice_last_codeunit", broken.charCodeAt(broken.length - 1).toString(16));
    proofLine("safe_prefix_len", signature!.rawPrefix.length);
    proofLine(
      "safe_prefix_last_codeunit",
      signature!.rawPrefix.charCodeAt(signature!.rawPrefix.length - 1).toString(16),
    );
    proofLine("safe_prefix_has_lone_surrogate", hasLoneSurrogate(signature!.rawPrefix));
    proofLine("safe_prefix_ends_with_emoji", signature!.rawPrefix.endsWith("\u{1F600}"));
  });

  it("keeps a boundary discriminator so distinct same-length text does not match", () => {
    const toolOutput = `${"a".repeat(9_999)}\u{1F600}${"a".repeat(400)}`;
    const signature = toolOutputRawEchoSignature(toolOutput)!;
    const distinct = `${"a".repeat(9_999)}b${"a".repeat(toolOutput.length - 10_000)}`;
    expect(distinct.length).toBe(toolOutput.length);
    // Backed-off prefix of only a×9999 would falsely match; full-scalar prefix does not.
    expect(distinct.startsWith(signature.rawPrefix)).toBe(false);
    expect(toolOutput.startsWith(signature.rawPrefix)).toBe(true);
    proofLine("discriminator_case", "distinct-same-length-no-match");
    proofLine("distinct_starts_with_prefix", distinct.startsWith(signature.rawPrefix));
    proofLine("echo_starts_with_prefix", toolOutput.startsWith(signature.rawPrefix));
  });
});
