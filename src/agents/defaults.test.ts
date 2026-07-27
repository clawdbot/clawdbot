import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";

describe("agent defaults", () => {
  // Regression guard: an Opus-tier Anthropic default here previously ran on
  // EVERY agent turn — including unattended 30-min heartbeats on always-on
  // gateways — and was the confirmed dominant driver of a $347-$1,382/day
  // Anthropic spend spike (Cost Watch, 2026-07-14+) across two machines.
  // Whatever the current provider/model default is, it must never regress
  // to an Opus-tier Anthropic model as the install-time/fresh-deploy value —
  // escalate per-agent/per-session via config instead.
  it("never defaults the primary agent model to an Opus-tier Anthropic model", () => {
    if (DEFAULT_PROVIDER === "anthropic") {
      expect(DEFAULT_MODEL).not.toMatch(/opus/i);
    }
  });

  it("keeps a sane provider + context window fallback", () => {
    expect(DEFAULT_PROVIDER.length).toBeGreaterThan(0);
    expect(DEFAULT_CONTEXT_TOKENS).toBeGreaterThan(0);
  });
});
