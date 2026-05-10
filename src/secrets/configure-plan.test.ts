import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  TALK_TEST_PROVIDER_API_KEY_PATH,
  TALK_TEST_PROVIDER_ID,
} from "../test-utils/talk-test-provider.js";
import {
  buildConfigureCandidates,
  buildConfigureCandidatesForScope,
  buildSecretsConfigurePlan,
  collectConfigureProviderChanges,
  hasConfigurePlanChanges,
} from "./configure-plan.js";

describe("secrets configure plan helpers", () => {
  it("builds configure candidates from supported configure targets", () => {
    const config = {
      talk: {
        providers: {
          [TALK_TEST_PROVIDER_ID]: {
            apiKey: "plain", // pragma: allowlist secret
          },
        },
      },
      channels: {
        telegram: {
          botToken: "token", // pragma: allowlist secret
        },
      },
    } as OpenClawConfig;

    const candidates = buildConfigureCandidates(config);
    const paths = candidates.map((entry) => entry.path);
    expect(paths).toContain(TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(paths).toContain("channels.telegram.botToken");
  });

  it("collects provider upserts and deletes", () => {
    const original = {
      secrets: {
        providers: {
          default: { source: "env" },
          legacy: { source: "env" },
        },
      },
    } as OpenClawConfig;
    const next = {
      secrets: {
        providers: {
          default: { source: "env", allowlist: ["OPENAI_API_KEY"] },
          modern: { source: "env" },
        },
      },
    } as OpenClawConfig;

    const changes = collectConfigureProviderChanges({ original, next });
    expect(Object.keys(changes.upserts).toSorted()).toEqual(["default", "modern"]);
    expect(changes.deletes).toEqual(["legacy"]);
  });

  it("discovers auth-profiles candidates for the selected agent scope", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {} as OpenClawConfig,
      authProfiles: {
        agentId: "main",
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk",
            },
          },
        },
      },
    });
    const openaiCandidate = candidates.find(
      (entry) => entry.path === "profiles.openai:default.key",
    );
    expect(openaiCandidate?.type).toBe("auth-profiles.api_key.key");
    expect(openaiCandidate?.agentId).toBe("main");
    expect(openaiCandidate?.configFile).toBe("auth-profiles.json");
    expect(openaiCandidate?.authProfileProvider).toBe("openai");
  });

  it("captures existing refs for prefilled configure prompts", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {
        talk: {
          providers: {
            [TALK_TEST_PROVIDER_ID]: {
              apiKey: {
                source: "env",
                provider: "default",
                id: "TALK_API_KEY",
              },
            },
          },
        },
      } as OpenClawConfig,
      authProfiles: {
        agentId: "main",
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              keyRef: {
                source: "env",
                provider: "default",
                id: "OPENAI_API_KEY",
              },
            },
          },
        },
      },
    });

    const talkCandidate = candidates.find(
      (entry) => entry.path === TALK_TEST_PROVIDER_API_KEY_PATH,
    );
    expect(talkCandidate?.existingRef).toStrictEqual({
      source: "env",
      provider: "default",
      id: "TALK_API_KEY",
    });

    const openaiCandidate = candidates.find(
      (entry) => entry.path === "profiles.openai:default.key",
    );
    expect(openaiCandidate?.existingRef).toStrictEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY", // pragma: allowlist secret
    });
  });

  it("marks normalized alias paths as derived when not authored directly", () => {
    const candidates = buildConfigureCandidatesForScope({
      config: {
        talk: {
          provider: TALK_TEST_PROVIDER_ID,
          providers: {
            [TALK_TEST_PROVIDER_ID]: {
              apiKey: "demo-talk-key", // pragma: allowlist secret
            },
          },
          apiKey: "demo-talk-key", // pragma: allowlist secret
        },
      } as OpenClawConfig,
      authoredOpenClawConfig: {
        talk: {
          apiKey: "demo-talk-key", // pragma: allowlist secret
        },
      } as OpenClawConfig,
    });

    const normalized = candidates.find((entry) => entry.path === TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(normalized?.isDerived).toBe(true);
  });

  it("reports configure change presence and builds deterministic plan shape", () => {
    const selected = new Map([
      [
        TALK_TEST_PROVIDER_API_KEY_PATH,
        {
          type: "talk.providers.*.apiKey",
          path: TALK_TEST_PROVIDER_API_KEY_PATH,
          pathSegments: ["talk", "providers", TALK_TEST_PROVIDER_ID, "apiKey"],
          label: TALK_TEST_PROVIDER_API_KEY_PATH,
          configFile: "openclaw.json" as const,
          expectedResolvedValue: "string" as const,
          providerId: TALK_TEST_PROVIDER_ID,
          ref: {
            source: "env" as const,
            provider: "default",
            id: "TALK_API_KEY",
          },
        },
      ],
    ]);
    const providerChanges = {
      upserts: {
        default: { source: "env" as const },
      },
      deletes: [],
    };
    expect(
      hasConfigurePlanChanges({
        selectedTargets: selected,
        providerChanges,
      }),
    ).toBe(true);

    const plan = buildSecretsConfigurePlan({
      selectedTargets: selected,
      providerChanges,
      generatedAt: "2026-02-28T00:00:00.000Z",
    });
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]?.path).toBe(TALK_TEST_PROVIDER_API_KEY_PATH);
    expect(plan.providerUpserts).toEqual({
      default: { source: "env" },
    });
    expect(plan.options).toEqual({
      scrubEnv: true,
      scrubAuthProfilesForProviderTargets: true,
      scrubLegacyAuthJson: true,
    });
  });
});
