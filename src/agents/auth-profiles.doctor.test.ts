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

  it("delegates other provider hints to the provider plugin", async () => {
    buildProviderAuthDoctorHintWithPluginMock.mockResolvedValueOnce("Provider-owned repair");

    await expect(
      formatAuthDoctorHint({
        store: { version: 1, profiles: {} },
        provider: "demo",
      }),
    ).resolves.toBe("Provider-owned repair");
    expect(buildProviderAuthDoctorHintWithPluginMock).toHaveBeenCalledOnce();
  });
});
