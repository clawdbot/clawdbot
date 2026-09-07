import { describe, expect, it } from "vitest";
import {
  TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS,
  toolOutputRawEchoSignature,
} from "./event-projector-tool-output.js";

function proofLine(label: string, value: string | number | boolean): void {
  // Verbatim proof for PR evidence: exercises the production write-site helper.
  process.stdout.write(`[utf16-echo-proof] ${label}=${String(value)}\n`);
}

describe("toolOutputRawEchoSignature", () => {
  it("does not split a surrogate pair at the transcript budget (raw .slice would)", () => {
    // High surrogate of 😀 lands at index 9999; raw slice(0, 10000) keeps it.
    const text = `${"a".repeat(9_999)}😀${"a".repeat(400)}`;
    const broken = text.slice(0, TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS);
    expect(broken).toMatch(/[\uD800-\uDFFF]/);
    expect(broken.charCodeAt(broken.length - 1)).toBe(0xd83d);

    const signature = toolOutputRawEchoSignature(text);
    expect(signature).toBeDefined();
    expect(signature!.rawLength).toBe(text.length);
    expect(signature!.rawPrefix).not.toMatch(/[\uD800-\uDFFF]/);
    expect(signature!.rawPrefix.endsWith("😀")).toBe(false);
    expect(signature!.rawPrefix).toBe("a".repeat(9_999));

    proofLine("write_site", "toolOutputRawEchoSignature.rawPrefix");
    proofLine("budget", TOOL_TRANSCRIPT_OUTPUT_MAX_CHARS);
    proofLine("broken_slice_len", broken.length);
    proofLine("broken_slice_last_codeunit", broken.charCodeAt(broken.length - 1).toString(16));
    proofLine("safe_prefix_len", signature!.rawPrefix.length);
    proofLine(
      "safe_prefix_last_codeunit",
      signature!.rawPrefix.charCodeAt(signature!.rawPrefix.length - 1).toString(16),
    );
    proofLine("safe_prefix_has_surrogate", /[\uD800-\uDFFF]/.test(signature!.rawPrefix));
  });
});
