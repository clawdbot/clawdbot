// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractQuickSettingsSecurity } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";

function makeState(config: Record<string, unknown>): AppViewState {
  return { configForm: config } as unknown as AppViewState;
}

describe("extractQuickSettingsSecurity", () => {
  it("reads execPolicy from the canonical tools.exec.security path", () => {
    const result = extractQuickSettingsSecurity(
      makeState({ tools: { exec: { security: "full" } } }),
    );

    expect(result.execPolicy).toBe("full");
  });

  it("reads execPolicy from tools.exec.security when set to deny", () => {
    const result = extractQuickSettingsSecurity(
      makeState({ tools: { exec: { security: "deny" } } }),
    );

    expect(result.execPolicy).toBe("deny");
  });

  it("falls back to allowlist when tools.exec.security is missing", () => {
    expect(extractQuickSettingsSecurity(makeState({})).execPolicy).toBe("allowlist");
    expect(extractQuickSettingsSecurity(makeState({ tools: { exec: {} } })).execPolicy).toBe(
      "allowlist",
    );
  });

  it("reads browser enabled and tool profile from canonical config paths", () => {
    const result = extractQuickSettingsSecurity(
      makeState({ browser: { enabled: false }, tools: { profile: "messaging" } }),
    );

    expect(result.browserEnabled).toBe(false);
    expect(result.toolProfile).toBe("messaging");
  });

  it("uses effective quick settings defaults when browser and tool profile are unset", () => {
    const result = extractQuickSettingsSecurity(makeState({}));

    expect(result.browserEnabled).toBe(true);
    expect(result.toolProfile).toBe("full");
  });

  it("ignores agents.defaults.exec.security because it is not a schema path", () => {
    const result = extractQuickSettingsSecurity(
      makeState({
        tools: { exec: { security: "full" } },
        agents: { defaults: { exec: { security: "deny" } } },
      }),
    );

    expect(result.execPolicy).toBe("full");
  });

  it("does not treat agents.defaults.exec.security as a fallback", () => {
    const result = extractQuickSettingsSecurity(
      makeState({ agents: { defaults: { exec: { security: "full" } } } }),
    );

    expect(result.execPolicy).toBe("allowlist");
  });

  it("trims whitespace and ignores empty strings", () => {
    expect(
      extractQuickSettingsSecurity(makeState({ tools: { exec: { security: "  full  " } } }))
        .execPolicy,
    ).toBe("full");
    expect(
      extractQuickSettingsSecurity(makeState({ tools: { exec: { security: "   " } } })).execPolicy,
    ).toBe("allowlist");
    expect(
      extractQuickSettingsSecurity(makeState({ tools: { profile: "  coding  " } })).toolProfile,
    ).toBe("coding");
  });
});
