/** Covers the operator-policy filter shared by plugin auto-enable and channel schema ownership. */
import { describe, expect, it } from "vitest";
import { isPluginPolicyDisabled } from "./plugin-replacement-eligibility.js";
import type { OpenClawConfig } from "./types.openclaw.js";

describe("isPluginPolicyDisabled", () => {
  // #123209: the loader compares against the normalized policy view, so a raw lookup here let
  // schema ownership treat a plugin as active that the runtime never loads.
  it.each([
    { label: "padded, upper-cased deny entry", config: { plugins: { deny: [" MODERN "] } } },
    {
      label: "padded entry key disabled",
      config: { plugins: { entries: { " Modern ": { enabled: false } } } },
    },
  ])("treats $label as disabled", ({ config }) => {
    expect(isPluginPolicyDisabled(config as OpenClawConfig, "modern")).toBe(true);
  });

  it("resolves built-in plugin aliases before matching policy", () => {
    const config = { plugins: { deny: ["google-gemini-cli"] } } as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "google")).toBe(true);
  });

  it("reads a bundled channel plugin disabled through its channel config", () => {
    const config = { channels: { telegram: { enabled: false } } } as unknown as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "telegram")).toBe(true);
  });

  it("leaves an untouched plugin enabled", () => {
    const config = {
      plugins: { deny: ["other"], entries: { modern: { enabled: true } } },
    } as OpenClawConfig;

    expect(isPluginPolicyDisabled(config, "modern")).toBe(false);
  });
});
