// Covers fatal error hook registration and output collection.
import { describe, expect, it } from "vitest";
import { registerFatalErrorHook, runFatalErrorHooks } from "./fatal-error-hooks.js";

describe("fatal error hooks", () => {
  it("collects non-empty hook messages", () => {
    const unsubscribeFirst = registerFatalErrorHook(() => "first");
    const unsubscribeBlank = registerFatalErrorHook(() => "  ");
    const unsubscribeSecond = registerFatalErrorHook(() => "second");

    try {
      expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual(["first", "second"]);

      unsubscribeFirst();
      expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual(["second"]);
      unsubscribeFirst();
      expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual(["second"]);
    } finally {
      unsubscribeFirst();
      unsubscribeBlank();
      unsubscribeSecond();
    }
    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual([]);
  });

  it("does not expose hook failure message or stack text", () => {
    const unsubscribe = registerFatalErrorHook(() => {
      throw new Error("raw secret from hook");
    });

    try {
      const messages = runFatalErrorHooks({ reason: "uncaught_exception" });
      const output = messages.join("\n");

      expect(messages).toEqual(["fatal-error hook failed: Error"]);
      expect(output).not.toContain("raw secret");
      expect(output).not.toContain("at ");
    } finally {
      unsubscribe();
    }
  });
});
