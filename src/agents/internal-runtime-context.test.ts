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
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
  relocateCurrentRuntimeContextCarrierToTail,
  shouldRelocateRuntimeContextCarrierToTail,
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

describe("shouldRelocateRuntimeContextCarrierToTail", () => {
  it("returns false for local/self-hosted provider strings", () => {
    expect(shouldRelocateRuntimeContextCarrierToTail("ollama")).toBe(false);
    expect(shouldRelocateRuntimeContextCarrierToTail("Ollama")).toBe(false);
    expect(shouldRelocateRuntimeContextCarrierToTail("vllm")).toBe(false);
    expect(shouldRelocateRuntimeContextCarrierToTail("lmstudio")).toBe(false);
    expect(shouldRelocateRuntimeContextCarrierToTail("sglang")).toBe(false);
    expect(shouldRelocateRuntimeContextCarrierToTail("llama-cpp")).toBe(false);
    expect(shouldRelocateRuntimeContextCarrierToTail("local")).toBe(false);
  });

  it("returns false for self-hosted providers with custom non-local hostnames", () => {
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "sglang",
        model: {
          id: "meta-llama/Llama-3-70b-Instruct",
          provider: "sglang",
          baseUrl: "http://gpu-cluster.internal.org:30000/v1",
        },
      }),
    ).toBe(false);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "llama-cpp",
        model: {
          id: "mistral-7b",
          provider: "llama-cpp",
          baseUrl: "http://my-server.corp.net:8080/v1",
        },
      }),
    ).toBe(false);
  });

  it("returns false for custom providers with api: ollama", () => {
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "ollama-fast",
        model: { api: "ollama", provider: "ollama-fast", baseUrl: "http://example.com" },
      }),
    ).toBe(false);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "ollama-large",
        model: { api: "ollama", provider: "ollama-large" },
      }),
    ).toBe(false);
  });

  it("returns false for custom local providers with local base URLs", () => {
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "custom-local",
        model: { baseUrl: "http://127.0.0.1:11434" },
      }),
    ).toBe(false);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "my-vllm",
        model: { baseUrl: "http://localhost:8000/v1" },
      }),
    ).toBe(false);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "lan-llm",
        model: { baseUrl: "http://192.168.1.100:8000/v1" },
      }),
    ).toBe(false);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "mesh-node",
        model: { baseUrl: "http://ollama-box.local:11434" },
      }),
    ).toBe(false);
  });

  it("returns true for cloud models behind local proxies (LiteLLM, local reverse proxies)", () => {
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "openai",
        model: {
          id: "gpt-5",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:4000/v1",
        },
      }),
    ).toBe(true);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "anthropic",
        model: {
          id: "claude-opus-5",
          api: "anthropic-messages",
          baseUrl: "http://192.168.1.20:8080",
        },
      }),
    ).toBe(true);
  });

  it("returns true for Ollama cloud models (*:cloud) even with api: ollama or local baseUrl", () => {
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "ollama",
        model: { id: "kimi-k2.5:cloud", api: "ollama", baseUrl: "http://127.0.0.1:11434" },
      }),
    ).toBe(true);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "ollama",
        model: {
          id: "ollama/gpt-oss:120b-cloud",
          api: "ollama",
          baseUrl: "http://localhost:11434",
        },
      }),
    ).toBe(true);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "ollama-proxy",
        model: { id: "minimax-m3:cloud", baseUrl: "http://192.168.1.100:11434" },
      }),
    ).toBe(true);
  });

  it("returns true for the built-in ollama-cloud provider with bare model IDs and api: ollama", () => {
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "ollama-cloud",
        model: { id: "gpt-oss:120b", api: "ollama", baseUrl: "https://ollama.com" },
      }),
    ).toBe(true);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        model: {
          id: "glm-5.2",
          api: "ollama",
          provider: "ollama-cloud",
          baseUrl: "https://ollama.com",
        },
      }),
    ).toBe(true);
  });

  it("returns true for provider: ollama pointing to a hosted endpoint with bare model IDs", () => {
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "ollama",
        model: { id: "gpt-oss:20b", api: "ollama", baseUrl: "https://ollama.com/v1" },
      }),
    ).toBe(true);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "ollama",
        model: { id: "gpt-oss:20b", baseUrl: "https://ollama.com" },
      }),
    ).toBe(true);
  });

  it("returns true for cloud providers or unspecified provider", () => {
    expect(shouldRelocateRuntimeContextCarrierToTail("anthropic")).toBe(true);
    expect(shouldRelocateRuntimeContextCarrierToTail("openai")).toBe(true);
    expect(shouldRelocateRuntimeContextCarrierToTail("openrouter")).toBe(true);
    expect(shouldRelocateRuntimeContextCarrierToTail(undefined)).toBe(true);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "anthropic",
        model: { baseUrl: "https://api.anthropic.com" },
      }),
    ).toBe(true);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "openai",
        model: { baseUrl: "https://api.openai.com/v1" },
      }),
    ).toBe(true);
  });

  it("preserves tail relocation for the bundled and configured LiteLLM cloud routes", () => {
    // Documented onboarding-generated route (provider: "litellm", api: "openai-completions", baseUrl: "http://localhost:4000")
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "litellm",
        model: {
          id: "claude-opus-4-6",
          api: "openai-completions",
          baseUrl: "http://localhost:4000",
        },
      }),
    ).toBe(true);

    // LiteLLM with loopback IP and cloud model
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "litellm",
        model: {
          id: "gpt-5",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:4000",
        },
      }),
    ).toBe(true);

    // LiteLLM with explicit provider-prefixed cloud ref
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "litellm",
        model: {
          id: "anthropic/claude-sonnet-4-6",
          api: "openai-completions",
          baseUrl: "http://localhost:4000",
        },
      }),
    ).toBe(true);

    // LiteLLM proxying an explicit self-hosted backend does not relocate
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "litellm",
        model: {
          id: "ollama/gpt-oss:20b",
          api: "openai-completions",
          baseUrl: "http://localhost:4000",
        },
      }),
    ).toBe(false);

    // Custom local OpenAI-compatible server does not get broadly classified as cloud
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "custom-local",
        model: {
          id: "llama-3-8b",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8000/v1",
        },
      }),
    ).toBe(false);

    // Custom local backend serving open-weights gpt-oss models does not infer cloud from "gpt-" or "openai/"
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "custom-local",
        model: {
          id: "gpt-oss-20b",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8000/v1",
        },
      }),
    ).toBe(false);
    expect(
      shouldRelocateRuntimeContextCarrierToTail({
        provider: "custom-local",
        model: {
          id: "openai/gpt-oss-20b",
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:8000/v1",
        },
      }),
    ).toBe(false);
  });
});
