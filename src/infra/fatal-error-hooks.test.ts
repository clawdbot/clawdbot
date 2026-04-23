import { beforeEach, describe, expect, it } from "vitest";
import {
  registerFatalErrorHook,
  resetFatalErrorHooksForTest,
  runFatalErrorHooks,
} from "./fatal-error-hooks.js";

describe("fatal error hooks", () => {
  beforeEach(() => {
    resetFatalErrorHooksForTest();
  });

  it("collects non-empty hook messages", () => {
    registerFatalErrorHook(() => "first");
    registerFatalErrorHook(() => "  ");
    registerFatalErrorHook(() => "second");

    expect(runFatalErrorHooks({ reason: "uncaught_exception" })).toEqual(["first", "second"]);
  });

  it("does not expose hook failure message or stack text", () => {
    registerFatalErrorHook(() => {
      throw new Error("raw secret from hook");
    });

    const messages = runFatalErrorHooks({ reason: "uncaught_exception" });
    const output = messages.join("\n");

    expect(messages).toEqual(["fatal-error hook failed: Error"]);
    expect(output).not.toContain("raw secret");
    expect(output).not.toContain("at ");
  });
});
