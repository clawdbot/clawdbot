/**
 * Auth-profile doctor copy tests.
 * Covers provider-specific repair hints without invoking real auth flows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildProviderAuthDoctorHintWithPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  buildProviderAuthDoctorHintWithPlugin: buildProviderAuthDoctorHintWithPluginMock,
}));

import { formatAuthDoctorHint } from "./auth-profiles/doctor.js";

describe("formatAuthDoctorHint", () => {
  beforeEach(() => {
    buildProviderAuthDoctorHintWithPluginMock.mockReset();
    buildProviderAuthDoctorHintWithPluginMock.mockResolvedValue(undefined);
  });

  it("guides legacy qwen portal oauth profiles to re-authenticate", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "qwen-portal-auth": {
            type: "oauth",
            provider: "qwen-portal",
            access: "old-access",
            refresh: "old-refresh",
            expires: 0,
          },
        },
      },
      provider: "qwen-portal",
      profileId: "qwen-portal-auth",
    });

    expect(hint).toBe(
      "Legacy Qwen Portal OAuth profiles are not refreshable. Re-authenticate with a current Qwen API key: openclaw onboard --auth-choice qwen-api-key.",
    );
    expect(buildProviderAuthDoctorHintWithPluginMock).not.toHaveBeenCalled();
  });

  it("guides an unsupported github-copilot enterprise profile to login again", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "oauth",
            provider: "github-copilot",
            access: "fake",
            refresh: "fake",
            expires: 0,
            enterpriseUrl: "attacker.example",
          },
        },
      },
      provider: "github-copilot",
      profileId: "github-copilot:default",
    });

    expect(hint).toContain("unsupported enterprise domain");
    expect(hint).toContain("openclaw models auth login --provider github-copilot --force");
    expect(buildProviderAuthDoctorHintWithPluginMock).not.toHaveBeenCalled();
  });

  it("accepts a github-copilot profile on a ghe.com tenant", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "oauth",
            provider: "github-copilot",
            access: "fake",
            refresh: "fake",
            expires: 0,
            enterpriseUrl: "acme.ghe.com",
          },
        },
      },
      provider: "github-copilot",
      profileId: "github-copilot:default",
    });

    expect(hint).not.toContain("unsupported enterprise domain");
    expect(buildProviderAuthDoctorHintWithPluginMock).toHaveBeenCalledOnce();
  });

  it("accepts a public github.com profile", async () => {
    const hint = await formatAuthDoctorHint({
      store: {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "oauth",
            provider: "github-copilot",
            access: "fake",
            refresh: "fake",
            expires: 0,
          },
        },
      },
      provider: "github-copilot",
      profileId: "github-copilot:default",
    });

    expect(hint).not.toContain("unsupported enterprise domain");
    expect(buildProviderAuthDoctorHintWithPluginMock).toHaveBeenCalledOnce();
  });
});
