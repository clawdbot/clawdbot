import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  applyModelRuntimeDirective,
  resolveModelRuntimeDirective,
} from "./directive-handling.model-runtime.js";

const baseConfig = {} as OpenClawConfig;

function configWith(plugins: NonNullable<OpenClawConfig["plugins"]>): OpenClawConfig {
  return { plugins } as OpenClawConfig;
}

describe("resolveModelRuntimeDirective app-server owner availability", () => {
  it("accepts a bridge runtime whose owner plugin is available", () => {
    expect(
      resolveModelRuntimeDirective({
        rawRuntime: "copilot",
        provider: "github-copilot",
        cfg: baseConfig,
      }),
    ).toEqual({ kind: "set", runtime: "copilot" });
  });

  it("rejects a bridge runtime whose owner plugin is disabled", () => {
    const resolution = resolveModelRuntimeDirective({
      rawRuntime: "copilot",
      provider: "github-copilot",
      cfg: configWith({ entries: { copilot: { enabled: false } } }),
    });

    expect(resolution.kind).toBe("invalid");
    expect(resolution.kind === "invalid" && resolution.errorText).toContain(
      'no enabled plugin owns agent harness "copilot"',
    );
  });

  it("rejects a bridge runtime excluded by a restrictive plugin allowlist", () => {
    expect(
      resolveModelRuntimeDirective({
        rawRuntime: "copilot",
        provider: "github-copilot",
        cfg: configWith({ allow: ["telegram"] }),
      }).kind,
    ).toBe("invalid");
  });

  it("persists nothing when a runtime directive is rejected", () => {
    const entry: { agentRuntimeOverride?: string } = {};
    const resolution = resolveModelRuntimeDirective({
      rawRuntime: "copilot",
      provider: "github-copilot",
      cfg: configWith({ entries: { copilot: { enabled: false } } }),
    });

    expect(applyModelRuntimeDirective(entry, resolution)).toEqual({ updated: false });
    expect(entry.agentRuntimeOverride).toBeUndefined();
  });

  it("does not gate the built-in runtime on a harness owner plugin", () => {
    expect(
      resolveModelRuntimeDirective({
        rawRuntime: "openclaw",
        provider: "github-copilot",
        cfg: configWith({ entries: { copilot: { enabled: false } } }),
      }),
    ).toEqual({ kind: "set", runtime: "openclaw" });
  });

  it("keeps the unsupported-pairing message for an incompatible runtime", () => {
    const resolution = resolveModelRuntimeDirective({
      rawRuntime: "copilot",
      provider: "anthropic",
      cfg: baseConfig,
    });

    expect(resolution.kind).toBe("invalid");
    expect(resolution.kind === "invalid" && resolution.errorText).toBe(
      'Runtime "copilot" is not supported for anthropic.',
    );
  });
});
