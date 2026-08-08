// Anthropic tests cover the live-discovery contract gate.
import { describe, expect, it } from "vitest";
import { acceptsAnthropicLiveModelContract } from "./live-model-contract-gate.js";

/** Capability tree shaped like Anthropic's `/v1/models` response. */
function capabilities(params: {
  adaptive: boolean;
  xhigh: boolean;
  max: boolean;
}): Record<string, unknown> {
  return {
    capabilities: {
      image_input: { supported: true },
      thinking: {
        supported: true,
        types: {
          enabled: { supported: !params.adaptive },
          adaptive: { supported: params.adaptive },
        },
      },
      effort: {
        low: { supported: params.max },
        high: { supported: params.max },
        xhigh: { supported: params.xhigh },
        max: { supported: params.max },
      },
    },
  };
}

const MODERN = { adaptive: true, xhigh: true, max: true };
const LEGACY = { adaptive: false, xhigh: false, max: false };

describe("acceptsAnthropicLiveModelContract", () => {
  it("accepts current models whose advertised capabilities match our contracts", () => {
    // Adaptive + full effort range: what the contracts already shape correctly.
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-opus-4-8"]) {
      expect(acceptsAnthropicLiveModelContract({ id, record: capabilities(MODERN) }), id).toBe(
        true,
      );
    }
  });

  it("accepts legacy models that correctly advertise no adaptive thinking", () => {
    // The gate must not confuse "old model we shape with budget_tokens" for
    // "model we do not understand" — both miss the modern predicates.
    for (const id of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-3-opus-20240229"]) {
      expect(acceptsAnthropicLiveModelContract({ id, record: capabilities(LEGACY) }), id).toBe(
        true,
      );
    }
  });

  it("rejects an unreleased model generation our contracts do not recognize", () => {
    // The regression this gate exists to prevent: a future Claude family that
    // needs adaptive shaping but matches no version predicate, so it would be
    // sent manual budget_tokens plus sampling params and 400 on every request.
    for (const id of ["claude-opus-6", "claude-sonnet-6", "claude-zephyr-1"]) {
      expect(acceptsAnthropicLiveModelContract({ id, record: capabilities(MODERN) }), id).toBe(
        false,
      );
    }
  });

  it("rejects a known model whose advertised capabilities drift from our contracts", () => {
    // If Anthropic changes a shipped model's capabilities, our shaping is stale
    // for it; hide it rather than keep sending the old request shape.
    expect(
      acceptsAnthropicLiveModelContract({
        id: "claude-opus-5",
        record: capabilities({ adaptive: false, xhigh: true, max: true }),
      }),
    ).toBe(false);
    expect(
      acceptsAnthropicLiveModelContract({
        id: "claude-haiku-4-5",
        record: capabilities(MODERN),
      }),
    ).toBe(false);
  });

  it("fails closed when the capability tree is missing or unreadable", () => {
    for (const record of [
      {},
      { capabilities: null },
      { capabilities: "yes" },
      { capabilities: {} },
      { capabilities: { thinking: { types: { adaptive: {} } } } },
    ] as Record<string, unknown>[]) {
      expect(acceptsAnthropicLiveModelContract({ id: "claude-opus-5", record })).toBe(false);
    }
  });
});
