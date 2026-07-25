/**
 * Regression coverage for internal runtime-context stripping and extraction.
 * Verifies protected delimiters, legacy blocks, and custom-message filtering.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  escapeInternalRuntimeContextDelimiters,
  extractInternalRuntimeContext,
  hasInternalRuntimeContext,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  relocateCurrentRuntimeContextCarrierToTail,
  stripInternalRuntimeContext,
} from "./internal-runtime-context.js";

type TestMessage = { role: string; content: string; customType?: string };

function carrier(content = "runtime ctx"): TestMessage {
  return { role: "custom", customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, content };
}
function user(content: string): TestMessage {
  return { role: "user", content };
}
function assistant(content: string): TestMessage {
  return { role: "assistant", content };
}
function toolResult(content: string): TestMessage {
  return { role: "toolResult", content };
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("internal runtime context codec", () => {
  it("strips a marked internal runtime block and preserves surrounding text", () => {
    const input = [
      "Visible intro",
      "",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "",
      "[Internal task completion event]",
      "source: subagent",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Visible outro",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Visible intro\n\nVisible outro");
  });

  it("extracts marked internal runtime blocks and preserves surrounding text", () => {
    const first = [
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "first secret",
      INTERNAL_RUNTIME_CONTEXT_END,
    ].join("\n");
    const second = [
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "second secret",
      INTERNAL_RUNTIME_CONTEXT_END,
    ].join("\n");
    const input = ["Visible intro", "", first, "", "Visible middle", "", second].join("\n");

    expect(extractInternalRuntimeContext(input)).toEqual({
      text: "Visible intro\n\nVisible middle",
      runtimeContext: [first, "", second].join("\n"),
    });
  });

  it("fails closed when extracting malformed marked internal runtime blocks", () => {
    const input = [
      "Visible intro",
      "",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "secret runtime context",
      "",
      "Visible-looking tail",
    ].join("\n");

    expect(extractInternalRuntimeContext(input)).toEqual({
      text: "Visible intro",
    });
  });

  it("detects canonical runtime context and ignores inline marker mentions", () => {
    expect(
      hasInternalRuntimeContext(
        `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\ninternal\n${INTERNAL_RUNTIME_CONTEXT_END}`,
      ),
    ).toBe(true);
    expect(
      hasInternalRuntimeContext(
        `Inline token ${INTERNAL_RUNTIME_CONTEXT_BEGIN} should not count as a block marker.`,
      ),
    ).toBe(false);
  });

  it("fuzzes delimiter injection and nested marker handling deterministically", () => {
    const rng = createDeterministicRng(0xc0ff_ee42);
    const tokenPool = [
      "plain output line",
      "status: ok",
      `inline ${INTERNAL_RUNTIME_CONTEXT_BEGIN} mention`,
      `inline ${INTERNAL_RUNTIME_CONTEXT_END} mention`,
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      INTERNAL_RUNTIME_CONTEXT_END,
      "more details",
    ];

    for (let index = 0; index < 120; index++) {
      const lineCount = 4 + Math.floor(rng() * 12);
      const payloadLines: string[] = [];
      for (let i = 0; i < lineCount; i++) {
        const token = expectDefined(
          tokenPool[Math.floor(rng() * tokenPool.length)],
          "tokenPool[Math.floor(rng() * tokenPool.length)] test invariant",
        );
        payloadLines.push(token);
      }
      const escapedPayload = payloadLines.map((line) =>
        escapeInternalRuntimeContextDelimiters(line),
      );

      const visible = `Visible reply ${index}`;
      const wrapped = [
        INTERNAL_RUNTIME_CONTEXT_BEGIN,
        ...escapedPayload,
        INTERNAL_RUNTIME_CONTEXT_END,
        "",
        visible,
      ].join("\n");

      const stripped = stripInternalRuntimeContext(wrapped);
      expect(stripped).toBe(visible);
      expect(stripped).not.toContain(INTERNAL_RUNTIME_CONTEXT_BEGIN);
      expect(stripped).not.toContain(INTERNAL_RUNTIME_CONTEXT_END);
    }
  });
});

describe("relocateCurrentRuntimeContextCarrierToTail", () => {
  it("moves a before-user carrier to the absolute tail", () => {
    const messages = [user("older"), assistant("reply"), carrier("meta"), user("active")];
    const out = relocateCurrentRuntimeContextCarrierToTail(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "custom"]);
    // Non-carrier order is preserved; the active user turn is no longer preceded
    // by the volatile carrier, so it caches as a stable prefix.
    expect(out.filter((m) => m.role !== "custom")).toEqual([
      user("older"),
      assistant("reply"),
      user("active"),
    ]);
    expect(out[out.length - 1]).toEqual(carrier("meta"));
  });

  it("moves the carrier past tool-call/tool-result scaffolding to the absolute tail", () => {
    const messages = [
      carrier("meta"),
      user("active"),
      assistant("tool call"),
      toolResult("tool output"),
    ];
    const out = relocateCurrentRuntimeContextCarrierToTail(messages);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "custom"]);
    expect(out[out.length - 1]).toEqual(carrier("meta"));
  });

  it("is a no-op (same reference) when the carrier is already at the tail", () => {
    const messages = [user("active"), assistant("tool call"), toolResult("out"), carrier("meta")];
    const out = relocateCurrentRuntimeContextCarrierToTail(messages);
    expect(out).toBe(messages);
  });

  it("is a no-op when there is no carrier", () => {
    const messages = [user("active"), assistant("reply")];
    expect(relocateCurrentRuntimeContextCarrierToTail(messages)).toBe(messages);
  });

  it("leaves a carrier in place when there is no active user turn to anchor after", () => {
    const messages = [carrier("meta"), assistant("reply")];
    expect(relocateCurrentRuntimeContextCarrierToTail(messages)).toBe(messages);
  });
});
