// Tests inline reply directive parsing and whitespace-preserving behavior.
import { describe, expect, it } from "vitest";
import { extractInlineSimpleCommand, stripInlineStatus } from "./reply-inline.js";

describe("stripInlineStatus", () => {
  it("strips /status directive from message", () => {
    const result = stripInlineStatus("/status hello world");
    expect(result.cleaned).toBe("hello world");
    expect(result.didStrip).toBe(true);
  });

  it("preserves newlines in multi-line messages", () => {
    const result = stripInlineStatus("first line\nsecond line\nthird line");
    expect(result.cleaned).toBe("first line\nsecond line\nthird line");
    expect(result.didStrip).toBe(false);
  });

  it("preserves newlines when stripping /status", () => {
    const result = stripInlineStatus("/status\nfirst paragraph\n\nsecond paragraph");
    expect(result.cleaned).toBe("first paragraph\n\nsecond paragraph");
    expect(result.didStrip).toBe(true);
  });

  it.each(["hello \t  world\r\n\t indented  line  \r\n", "   ", "\n    code\n"])(
    "leaves unrecognized text byte-identical: %j",
    (body) => {
      expect(stripInlineStatus(body)).toEqual({ cleaned: body, didStrip: false });
    },
  );

  it.each([
    ["/status:\r\n    if ready:\r\n        run()  \r\n", "    if ready:\r\n        run()  \r\n"],
    ["start  here /status and\tthere /STATUS\r\n    code", "start  here and\tthere\r\n    code"],
    ["before\n\n/status\n\n    after", "before\n\n\n    after"],
  ])("removes only status spans and their separators: %j", (body, cleaned) => {
    expect(stripInlineStatus(body)).toEqual({ cleaned, didStrip: true });
  });
});

describe("extractInlineSimpleCommand", () => {
  it("extracts /help command", () => {
    const result = extractInlineSimpleCommand("/help some question");
    expect(result?.command).toBe("/help");
    expect(result?.cleaned).toBe("some question");
  });

  it("preserves newlines after extracting command", () => {
    const result = extractInlineSimpleCommand("/help first line\nsecond line");
    expect(result?.command).toBe("/help");
    expect(result?.cleaned).toBe("first line\nsecond line");
  });

  it.each(["/help", "/commands", "/whoami", "/id"])(
    "preserves code bytes when extracting %s",
    (command) => {
      const code = "    if ready:\r\n\t\trun('a  b')  \r\n";
      expect(extractInlineSimpleCommand(`${command}\r\n${code}`)?.cleaned).toBe(code);
    },
  );

  it("returns null for empty body", () => {
    expect(extractInlineSimpleCommand("")).toBeNull();
    expect(extractInlineSimpleCommand(undefined)).toBeNull();
  });
});
