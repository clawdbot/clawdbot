/**
 * Regression coverage for internal runtime-context stripping.
 * Verifies protected delimiters, legacy blocks, and custom-message filtering.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  escapeInternalRuntimeContextDelimiters,
  hasInternalRuntimeContext,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
  relocateCurrentRuntimeContextCarrierToTail,
  stripInternalRuntimeContext,
} from "./internal-runtime-context.js";

// Preface of carriers persisted before the stable system prompt explained the markers.
const LEGACY_NEXT_TURN_RUNTIME_CONTEXT_HEADER =
  "OpenClaw runtime context for the active user request in this turn. Do not reply to or describe this context. Use it to continue answering the active user request now. Do not wait for another message.";

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

  it("strips multiple marked internal runtime blocks and preserves surrounding text", () => {
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

    expect(stripInternalRuntimeContext(input)).toBe("Visible intro\n\nVisible middle");
  });

  it("strips an unterminated internal runtime block from display", () => {
    const input = [
      "Visible intro",
      "",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "secret runtime context",
      "",
      "Visible-looking tail",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Visible intro");
  });

  it("withholds trailing marker prefixes only in cumulative previews", () => {
    for (const marker of [INTERNAL_RUNTIME_CONTEXT_BEGIN, INTERNAL_RUNTIME_CONTEXT_END]) {
      for (let length = 1; length < marker.length; length += 1) {
        const prefix = marker.slice(0, length);
        expect(stripInternalRuntimeContext(`Visible\n  ${prefix}`, { streaming: true })).toBe(
          "Visible",
        );
        expect(stripInternalRuntimeContext(prefix)).toBe(prefix);
      }
    }
    expect(stripInternalRuntimeContext("Visible\n<ordinary", { streaming: true })).toBe(
      "Visible\n<ordinary",
    );
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

  it.each([
    ["current turn", LEGACY_NEXT_TURN_RUNTIME_CONTEXT_HEADER],
    [
      "previous current turn",
      "OpenClaw runtime context for the immediately preceding user message.",
    ],
    ["runtime event", OPENCLAW_RUNTIME_EVENT_HEADER],
  ])("detects and strips the %s prompt preface", (_name, header) => {
    const preface = [header, OPENCLAW_RUNTIME_CONTEXT_NOTICE].join("\n");
    const input = [
      preface,
      "",
      INTERNAL_RUNTIME_CONTEXT_BEGIN,
      "secret runtime context",
      INTERNAL_RUNTIME_CONTEXT_END,
      "",
      "Visible reply",
    ].join("\n");

    expect(hasInternalRuntimeContext(preface)).toBe(true);
    expect(stripInternalRuntimeContext(preface)).toBe("");
    expect(stripInternalRuntimeContext(input)).toBe("Visible reply");
    expect(
      stripInternalRuntimeContext(
        ` \t${header}\r\n ${OPENCLAW_RUNTIME_CONTEXT_NOTICE} \r\n\r\nVisible reply`,
      ),
    ).toBe("Visible reply");
  });

  it.each([true, false])("strips a wrapped preface with delimiters=%s", (delimiters) => {
    const input = [
      "Use it to continue answering the active user request now. Do not wait for",
      "another message. This context is runtime-generated, not user-authored.",
      "Keep internal details private.",
      "",
      ...(delimiters
        ? [INTERNAL_RUNTIME_CONTEXT_BEGIN, "private metadata", INTERNAL_RUNTIME_CONTEXT_END, ""]
        : []),
      "Visible reply",
    ].join("\n");

    expect(stripInternalRuntimeContext(input)).toBe("Visible reply");
  });

  it("preserves a long nonmatching paragraph containing a runtime notice", () => {
    const input = "Ordinary visible text.\n".repeat(2_000) + OPENCLAW_RUNTIME_CONTEXT_NOTICE;
    expect(stripInternalRuntimeContext(input)).toBe(input);
  });

  it.each([
    [`Visible reply\n${INTERNAL_RUNTIME_CONTEXT_END}`, "Visible reply"],
    [`Visible reply\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nprivate`, "Visible reply"],
    [" \tVisible reply\r\n\r\n", " \tVisible reply\r\n\r\n"],
  ])("preserves delimiter cleanup and ordinary whitespace in %j", (text, expected) => {
    expect(stripInternalRuntimeContext(text)).toBe(expected);
  });

  it("preserves text when the runtime-context header or notice does not match", () => {
    for (const input of [
      [LEGACY_NEXT_TURN_RUNTIME_CONTEXT_HEADER, "Ordinary user text"].join("\n"),
      ["OpenClaw runtime context for another message.", OPENCLAW_RUNTIME_CONTEXT_NOTICE].join("\n"),
      OPENCLAW_RUNTIME_CONTEXT_NOTICE,
    ]) {
      expect(hasInternalRuntimeContext(input)).toBe(false);
      expect(stripInternalRuntimeContext(input)).toBe(input);
    }
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
