// Tests for exec output rendering helpers.
import { describe, expect, it } from "vitest";
import {
  appendExecTimeoutRetryGuidance,
  renderExecOutputText,
  renderExecUpdateText,
} from "./bash-tools.exec-output.js";

describe("appendExecTimeoutRetryGuidance", () => {
  it.each(["overall-timeout", "no-output-timeout"] as const)(
    "warns that %s may already have produced side effects",
    (exitReason) => {
      const text = appendExecTimeoutRetryGuidance("Command timed out.", exitReason);

      expect(text).toContain("external side effects may already have completed");
      expect(text).toContain("Verify the resulting state before retrying");
      expect(text).toContain("Do not automatically rerun non-idempotent commands");
      expect(text).toContain("known to be safe to retry");
    },
  );

  it("leaves non-timeout exits unchanged", () => {
    expect(appendExecTimeoutRetryGuidance("Command failed.", "signal")).toBe("Command failed.");
  });
});

describe("renderExecOutputText", () => {
  it("returns placeholder for undefined input", () => {
    expect(renderExecOutputText(undefined)).toBe("(no output)");
  });

  it("returns placeholder for empty string", () => {
    expect(renderExecOutputText("")).toBe("(no output)");
  });

  it("returns value for non-empty string", () => {
    expect(renderExecOutputText("hello")).toBe("hello");
  });

  it("returns value for whitespace-only string", () => {
    expect(renderExecOutputText("  ")).toBe("  ");
  });

  it("preserves newlines in output", () => {
    expect(renderExecOutputText("line1\nline2")).toBe("line1\nline2");
  });
});

describe("renderExecUpdateText", () => {
  it("returns placeholder when no tailText and no warnings", () => {
    expect(renderExecUpdateText({ warnings: [] })).toBe("(no output)");
  });

  it("returns tailText when no warnings", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: [] })).toBe("hello");
  });

  it("returns warnings when no tailText", () => {
    expect(renderExecUpdateText({ warnings: ["warning1"] })).toBe("warning1\n\n(no output)");
  });

  it("returns warnings followed by tailText", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: ["warning1"] })).toBe(
      "warning1\n\nhello",
    );
  });

  it("joins multiple warnings with newlines", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: ["warning1", "warning2"] })).toBe(
      "warning1\nwarning2\n\nhello",
    );
  });

  it("handles empty warnings array with tailText", () => {
    expect(renderExecUpdateText({ tailText: "hello", warnings: [] })).toBe("hello");
  });

  it("handles undefined tailText with warnings", () => {
    expect(renderExecUpdateText({ warnings: ["warning1"] })).toBe("warning1\n\n(no output)");
  });
});
