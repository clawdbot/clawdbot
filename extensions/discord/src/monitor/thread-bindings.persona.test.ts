// Discord tests cover thread bindings.persona plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThreadBindingPersona } from "./thread-bindings.persona.js";

describe("thread binding persona", () => {
  it("prefers explicit label and prefixes with gear", () => {
    expect(resolveThreadBindingPersona({ label: "codex thread", agentId: "codex" })).toBe(
      "⚙️ codex thread",
    );
  });

  it("falls back to agent id when label is missing", () => {
    expect(resolveThreadBindingPersona({ agentId: "codex" })).toBe("⚙️ codex");
  });

  it("does not split a surrogate pair at the length limit", () => {
    const prefix = "a".repeat(76);
    expect(resolveThreadBindingPersona({ label: `${prefix}😀tail` })).toBe(`⚙️ ${prefix}`);
  });
});
