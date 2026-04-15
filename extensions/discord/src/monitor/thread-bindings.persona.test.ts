import { describe, expect, it } from "vitest";
import {
  resolveThreadBindingPersona,
  resolveThreadBindingPersonaFromRecord,
} from "./thread-bindings.persona.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

describe("thread binding persona", () => {
  it("prefers explicit label and prefixes with gear", () => {
    expect(resolveThreadBindingPersona({ label: "codex thread", agentId: "codex" })).toBe(
      "⚙️ codex thread",
    );
  });

  it("falls back to agent id when label is missing", () => {
    expect(resolveThreadBindingPersona({ agentId: "codex" })).toBe("⚙️ codex");
  });

  it("builds persona from binding record", () => {
    const record = {
      accountId: "default",
      channelId: "parent-1",
      threadId: "thread-1",
      targetKind: "acp",
      targetSessionKey: "agent:codex:acp:session-1",
      agentId: "codex",
      boundBy: "system",
      boundAt: Date.now(),
      lastActivityAt: Date.now(),
      label: "codex-thread",
    } satisfies ThreadBindingRecord;
    expect(resolveThreadBindingPersonaFromRecord(record)).toBe("⚙️ codex-thread");
  });
});
