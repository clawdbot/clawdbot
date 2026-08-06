import { describe, expect, it } from "vitest";
import {
  advanceProtectionScanState,
  createProtectionScanState,
  resolveProtectionFastPath,
} from "./protection-fast-path.js";

/** Feeds prior visible text, then asks the fast path about the next delta. */
function verdictFor(prefix: string, incoming: string) {
  const state = createProtectionScanState();
  advanceProtectionScanState(state, prefix);
  return resolveProtectionFastPath(state, incoming);
}

describe("protection fast path", () => {
  it("reports fenced content as protected without a full parse", () => {
    const verdict = verdictFor("intro\n\n```toml\n", "[read]\n");
    expect(verdict?.(0)).toBe(true);
  });

  it("reports ordinary prose as unprotected", () => {
    const verdict = verdictFor("intro\n\nplain\n", "[read]\n");
    expect(verdict?.(0)).toBe(false);
  });

  it("closes a fence only on a matching delimiter run", () => {
    expect(verdictFor("```\ninside\n~~~\n", "[read]\n")?.(0)).toBe(true);
    expect(verdictFor("````\ninside\n```\n", "[read]\n")?.(0)).toBe(true);
    expect(verdictFor("```\ninside\n```\n", "[read]\n")?.(0)).toBe(false);
  });

  it("declines when a backtick fence carries a backtick in its info string", () => {
    // CommonMark: backticks are illegal in a backtick-fence info string, so the line
    // stays paragraph text. Treating it as an open fence would wrongly mark following
    // text protected and leave a real tool call unscrubbed.
    expect(verdictFor("```` ```\n", "[read]\n")).toBeUndefined();
    expect(verdictFor("```js`\n", "[read]\n")).toBeUndefined();
  });

  it("keeps tracking a tilde fence whose info string carries a backtick", () => {
    expect(verdictFor("~~~ js`\n", "[read]\n")?.(0)).toBe(true);
  });

  it("treats only spaces and tabs as closing-fence padding", () => {
    // U+00A0 after a closing delimiter does NOT close the block (CommonMark), so the
    // fence stays open and following text remains literal.
    expect(verdictFor("```\nliteral\n```\u00a0\n", "[read]\n")?.(0)).toBe(true);
    expect(verdictFor("```\nliteral\n```\t\n", "[read]\n")?.(0)).toBe(false);
    expect(verdictFor("```\nliteral\n```  \n", "[read]\n")?.(0)).toBe(false);
  });

  it("does not treat a Unicode-space line as blank", () => {
    // A U+00A0 line does not end a paragraph, so ambiguity must survive it.
    expect(verdictFor("a `code` b\n\u00a0\n", "[read]\n")).toBeUndefined();
  });

  it("declines for shapes it does not model", () => {
    expect(verdictFor("a `code` b\n", "[read]\n")).toBeUndefined();
    expect(verdictFor("> quoted\n", "[read]\n")).toBeUndefined();
    expect(verdictFor("- item\n", "[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "    [read]\n")).toBeUndefined();
  });

  it("declines for tab-indented code", () => {
    // CommonMark expands a leading tab to four columns, so a tabbed line is indented
    // code even with no spaces. Reporting it unprotected would scrub literal content.
    expect(verdictFor("para\n\n", "\t[read]\n")).toBeUndefined();
    expect(verdictFor("", "\t[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "  \t[read]\n")).toBeUndefined();
    // Four spaces then a tab is still indented code; the column count, not the
    // character class, decides.
    expect(verdictFor("para\n\n", "    \t[read]\n")).toBeUndefined();
    expect(verdictFor("para\n\n", "\t  [read]\n")).toBeUndefined();
  });

  it("declines for an unfinished line outside a fence", () => {
    expect(verdictFor("plain\n", "[read]")).toBeUndefined();
  });

  it("declines when a bare carriage return ends a line", () => {
    // findPotentialCallStart treats a lone CR as a line start and CommonMark ends the
    // line there, but this tracker splits on LF, so it must not answer.
    expect(verdictFor("```\nliteral\n```\r", "[read]\n")).toBeUndefined();
    expect(verdictFor("```\r[read]\r", "[read]\n")).toBeUndefined();
    expect(verdictFor("```\nliteral\n", "```\r[read]\n")).toBeUndefined();
    // CRLF is still tracked normally.
    expect(verdictFor("```toml\r\n", "[read]\r\n")?.(0)).toBe(true);
  });

  it("clears paragraph ambiguity at a blank line but never fence-parity doubt", () => {
    // An inline span cannot cross a blank line, so tracking resumes.
    expect(verdictFor("a `code` b\n\nplain\n", "[read]\n")?.(0)).toBe(false);
    // A delimiter that could not be classified leaves parity unknown for good.
    expect(verdictFor("- item\n```\n\nplain\n", "[read]\n")).toBeUndefined();
  });
});
