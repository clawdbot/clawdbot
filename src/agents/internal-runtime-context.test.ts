/**
 * Regression coverage for internal runtime-context stripping and extraction.
 * Verifies protected delimiters, legacy blocks, and custom-message filtering.
 */
import { describe, expect, it } from "vitest";
import {
  escapeInternalRuntimeContextDelimiters,
  extractInternalRuntimeContext,
  hasInternalRuntimeContext,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "./internal-runtime-context.js";

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
        const token = tokenPool[Math.floor(rng() * tokenPool.length)];
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
