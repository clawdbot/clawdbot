// Thread-binding message tests cover user-visible names and lifecycle text.
import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings-messages.js";

describe("thread-binding names", () => {
  it("does not split surrogate pairs at native name limits", () => {
    const threadName = resolveThreadBindingThreadName({
      label: `${"x".repeat(96)}🚀tail`,
    });
    const intro = resolveThreadBindingIntroText({
      label: `${"x".repeat(99)}🚀tail`,
    });

    expect(threadName).toBe(`🤖 ${"x".repeat(96)}`);
    expect(intro).toContain(`${"x".repeat(99)} session active`);
  });
});
