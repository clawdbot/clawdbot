// Qqbot tests cover response timeout plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { resolveResponseTimeoutMs } from "./response-timeout.js";

const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;

describe("resolveResponseTimeoutMs", () => {
  it("falls back to the historical 5-minute floor when no timeouts configured", () => {
    expect(resolveResponseTimeoutMs({})).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
    expect(resolveResponseTimeoutMs(undefined)).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
    expect(resolveResponseTimeoutMs(null)).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
  });

  it("honors longer agents.defaults.timeoutSeconds", () => {
    expect(resolveResponseTimeoutMs({ agents: { defaults: { timeoutSeconds: 900 } } })).toBe(
      900_000,
    );
  });

  it("ignores agents.defaults.timeoutSeconds shorter than the historical floor", () => {
    // Issue #85267: a configured 60s agent timeout must not undercut the
    // historical 5-minute watchdog floor for previously-working setups.
    expect(resolveResponseTimeoutMs({ agents: { defaults: { timeoutSeconds: 60 } } })).toBe(
      DEFAULT_RESPONSE_TIMEOUT_MS,
    );
  });

  it("honors models.providers.<id>.timeoutSeconds for slow local providers (#85267)", () => {
    // Direct repro shape: ollama + qwen3.5:27b with 1800s timeout. Without
    // this fix, QQBot capped at 300s and surfaced "LLM request timed out".
    expect(
      resolveResponseTimeoutMs({
        models: { providers: { ollama: { timeoutSeconds: 1800 } } },
      }),
    ).toBe(1_800_000);
  });

  it("takes the maximum across multiple configured providers and agents", () => {
    expect(
      resolveResponseTimeoutMs({
        agents: { defaults: { timeoutSeconds: 600 } },
        models: {
          providers: {
            ollama: { timeoutSeconds: 1800 },
            "lm-studio": { timeoutSeconds: 900 },
            openai: { timeoutSeconds: 60 },
          },
        },
      }),
    ).toBe(1_800_000);
  });

  it("ignores non-positive or non-numeric timeout values", () => {
    expect(
      resolveResponseTimeoutMs({
        agents: { defaults: { timeoutSeconds: -1 } },
        models: {
          providers: {
            ollama: { timeoutSeconds: 0 },
            broken: { timeoutSeconds: "1800" as unknown as number },
            naN: { timeoutSeconds: Number.NaN },
          },
        },
      }),
    ).toBe(DEFAULT_RESPONSE_TIMEOUT_MS);
  });

  it("clamps to MAX_TIMER_TIMEOUT_MS for absurd inputs", () => {
    const huge = resolveResponseTimeoutMs({
      models: { providers: { ollama: { timeoutSeconds: 10_000_000 } } },
    });
    expect(huge).toBeLessThanOrEqual(MAX_TIMER_TIMEOUT_MS);
    expect(huge).toBeGreaterThan(DEFAULT_RESPONSE_TIMEOUT_MS);
  });
});
