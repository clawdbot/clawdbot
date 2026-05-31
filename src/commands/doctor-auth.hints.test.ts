import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatOAuthRefreshFailureDoctorLine,
  noteLegacyCodexProviderOverride,
  resolveUnusableProfileHint,
} from "./doctor-auth.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

vi.mock("../agents/auth-profiles.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/auth-profiles.js")>(
    "../agents/auth-profiles.js",
  );
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  };
});

function doctorFixtureConfig(config: unknown): OpenClawConfig {
  return config as OpenClawConfig;
}

describe("resolveUnusableProfileHint", () => {
  beforeEach(() => {
    mocks.ensureAuthProfileStore.mockReset().mockReturnValue({ version: 1, profiles: {} });
    mocks.note.mockClear();
  });

  it("returns billing guidance for disabled billing profiles", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "billing" })).toBe(
      "Top up credits (provider billing) or switch provider.",
    );
  });

  it("returns credential guidance for permanent auth disables", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "auth_permanent" })).toBe(
      "Refresh or replace credentials, then retry.",
    );
  });

  it("falls back to cooldown guidance for non-billing disable reasons", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "unknown" })).toBe(
      "Wait for cooldown or switch provider.",
    );
  });

  it("returns cooldown guidance for cooldown windows", () => {
    expect(resolveUnusableProfileHint({ kind: "cooldown" })).toBe(
      "Wait for cooldown or switch provider.",
    );
  });

  it("formats permanent OAuth refresh failures as reauth-required", () => {
    expect(
      formatOAuthRefreshFailureDoctorLine({
        profileId: "openai-codex:default",
        provider: "openai-codex",
        message:
          "OAuth token refresh failed for openai-codex: refresh_token_reused. Please try again or re-authenticate.",
      }),
    ).toBe(
      "- openai-codex:default: re-auth required [refresh_token_reused] — Run `openclaw models auth login --provider openai`.",
    );
  });

  it("formats non-permanent OAuth refresh failures as retry-then-reauth guidance", () => {
    expect(
      formatOAuthRefreshFailureDoctorLine({
        profileId: "openai-codex:default",
        provider: "openai-codex",
        message:
          "OAuth token refresh failed for openai-codex: temporary upstream issue. Please try again or re-authenticate.",
      }),
    ).toBe(
      "- openai-codex:default: OAuth refresh failed — Try again; if this persists, run `openclaw models auth login --provider openai`.",
    );
  });

  it("drops the provider-specific command when the parsed provider is unsafe", () => {
    expect(
      formatOAuthRefreshFailureDoctorLine({
        profileId: "openai-codex:default",
        provider: "openai-codex",
        message:
          "OAuth token refresh failed for openai-codex`\nrm -rf /: invalid_grant. Please try again or re-authenticate.",
      }),
    ).toBe(
      "- openai-codex:default: re-auth required [invalid_grant] — Run `openclaw models auth login --provider openai`.",
    );
  });

  it("warns when a legacy Codex override shadows canonical OpenAI OAuth config", () => {
    noteLegacyCodexProviderOverride(
      doctorFixtureConfig({
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
        models: {
          providers: {
            "openai-codex": {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
            },
          },
        },
      }),
    );

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("models.providers.openai-codex"),
      "Codex OAuth",
    );
  });

  it("warns when a legacy Codex override shadows stored legacy OAuth state", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    });

    noteLegacyCodexProviderOverride(
      doctorFixtureConfig({
        models: {
          providers: {
            "openai-codex": {
              models: [{ id: "gpt-5.5", api: "openai-responses" }],
            },
          },
        },
      }),
    );

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("legacy transport override"),
      "Codex OAuth",
    );
  });
});
