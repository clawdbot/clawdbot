import { describe, expect, it } from "vitest";
import {
  listSetupInferenceAuthOptions,
  listSetupInferenceManualProviders,
  listSetupInferencePrepareOptions,
} from "../system-agent/setup-inference-auth-options.js";
import { resolveManifestDeclaredProviderAuthChoices } from "./provider-auth-choices.js";
import {
  listProviderAccessOptions,
  listProviderChannelLoginChoices,
  resolveProviderChannelLoginChoice,
} from "./provider-login-options.js";

function metadataSnapshot(
  providerAuthChoices: Array<Record<string, unknown>>,
  origin: "bundled" | "workspace" = "bundled",
) {
  return {
    manifestRegistry: {
      plugins: [{ id: "test-provider", origin, providerAuthChoices }],
    },
  } as never;
}

function choice(params: {
  provider: string;
  method: string;
  choiceId: string;
  aliases?: string[];
  default?: boolean;
  guided?: "auth" | "secret" | "setup";
  channelLogin?: boolean;
  onboardingScopes?: string[];
}) {
  const guided = params.guided ?? "auth";
  return {
    provider: params.provider,
    method: params.method,
    choiceId: params.choiceId,
    choiceLabel: params.choiceId,
    ...(guided === "secret"
      ? { appGuidedSecret: true }
      : guided === "auth"
        ? { appGuidedAuth: "oauth" }
        : {}),
    ...(params.channelLogin === false
      ? {}
      : {
          channelLogin: {
            ...(params.aliases ? { aliases: params.aliases } : {}),
            ...(params.default ? { default: true } : {}),
          },
        }),
    ...(params.onboardingScopes ? { onboardingScopes: params.onboardingScopes } : {}),
  };
}

describe("provider channel login choices", () => {
  it("routes every visible text-inference choice through Models and /login", () => {
    const visibleChoices = resolveManifestDeclaredProviderAuthChoices().filter(
      (entry) =>
        entry.assistantVisibility !== "manual-only" &&
        (!entry.onboardingScopes || entry.onboardingScopes.includes("text-inference")),
    );
    const accessChoiceIds = new Set(
      listProviderAccessOptions(visibleChoices).map((option) => option.id),
    );
    const missingModelsChoices = visibleChoices
      .filter((entry) => !accessChoiceIds.has(entry.choiceId))
      .map((entry) => entry.choiceId);
    const connectChoiceIds = new Set(
      [
        ...listSetupInferenceAuthOptions(visibleChoices),
        ...listSetupInferenceManualProviders(visibleChoices),
        ...listSetupInferencePrepareOptions(visibleChoices),
      ].map((option) => option.id),
    );
    const missingConnectChoices = visibleChoices
      .filter((entry) => !connectChoiceIds.has(entry.choiceId))
      .map((entry) => entry.choiceId);
    const missingLoginChoices = visibleChoices
      .filter((entry) => {
        const resolution = resolveProviderChannelLoginChoice(entry.choiceId);
        return resolution.status !== "resolved" || resolution.choice.choiceId !== entry.choiceId;
      })
      .map((entry) => entry.choiceId);

    expect(missingModelsChoices).toEqual([]);
    expect(missingConnectChoices).toEqual([]);
    expect(missingLoginChoices).toEqual([]);
  });

  it("lists the trusted bundled fixed-input login surface", () => {
    expect(listProviderChannelLoginChoices().filter((entry) => entry.mode === "chat")).toEqual([
      expect.objectContaining({ command: "codex", providerId: "openai", methodId: "device-code" }),
      expect.objectContaining({
        command: "minimax-cn-oauth",
        providerId: "minimax-portal",
        methodId: "oauth-cn",
      }),
      expect.objectContaining({
        command: "minimax-global-oauth",
        providerId: "minimax-portal",
        methodId: "oauth",
      }),
      expect.objectContaining({ command: "xai", providerId: "xai", methodId: "oauth" }),
    ]);
  });

  it("resolves guided secret providers to a secure Control UI handoff", () => {
    const snapshot = metadataSnapshot([
      choice({
        provider: "alpha",
        method: "api-key",
        choiceId: "alpha-api-key",
        guided: "secret",
        channelLogin: false,
      }),
    ]);

    expect(resolveProviderChannelLoginChoice("alpha", { metadataSnapshot: snapshot })).toEqual({
      status: "resolved",
      choice: expect.objectContaining({
        command: "alpha",
        mode: "secret",
        providerId: "alpha",
      }),
    });
  });

  it("resolves browser and device login to the Control UI sign-in section", () => {
    const snapshot = metadataSnapshot([
      choice({
        provider: "alpha",
        method: "oauth",
        choiceId: "alpha-oauth",
        channelLogin: false,
      }),
    ]);

    expect(resolveProviderChannelLoginChoice("alpha", { metadataSnapshot: snapshot })).toEqual({
      status: "resolved",
      choice: expect.objectContaining({
        choiceId: "alpha-oauth",
        mode: "sign-in",
        providerId: "alpha",
      }),
    });
  });

  it("prefers a provider's direct chat login over its guided secret method", () => {
    const snapshot = metadataSnapshot([
      choice({ provider: "alpha", method: "device", choiceId: "alpha-device" }),
      choice({
        provider: "alpha",
        method: "api-key",
        choiceId: "alpha-api-key",
        guided: "secret",
        channelLogin: false,
      }),
    ]);

    expect(resolveProviderChannelLoginChoice("alpha", { metadataSnapshot: snapshot })).toEqual({
      status: "resolved",
      choice: expect.objectContaining({ choiceId: "alpha-device", mode: "chat" }),
    });
  });

  it("resolves manifest-declared provider setup without treating it as login", () => {
    const snapshot = metadataSnapshot([
      choice({
        provider: "self-hosted",
        method: "custom",
        choiceId: "self-hosted",
        guided: "setup",
        channelLogin: false,
      }),
    ]);

    expect(
      resolveProviderChannelLoginChoice("self-hosted", { metadataSnapshot: snapshot }),
    ).toEqual({
      status: "resolved",
      choice: expect.objectContaining({ mode: "setup", providerId: "self-hosted" }),
    });
  });

  it("excludes image-only manifest choices from Control UI and chat login surfaces", () => {
    const snapshot = metadataSnapshot([
      choice({
        provider: "image-only",
        method: "custom",
        choiceId: "image-only",
        guided: "setup",
        channelLogin: false,
        onboardingScopes: ["image-generation"],
      }),
    ]);
    const metadata = resolveManifestDeclaredProviderAuthChoices({ metadataSnapshot: snapshot });

    expect(listProviderAccessOptions(metadata)).toEqual([]);
    expect(resolveProviderChannelLoginChoice("image-only", { metadataSnapshot: snapshot })).toEqual(
      { status: "unsupported", choices: [] },
    );
  });

  it("prefers an exact choice id over a colliding alias", () => {
    const snapshot = metadataSnapshot([
      choice({ provider: "alpha", method: "oauth", choiceId: "alpha", aliases: ["shared"] }),
      choice({ provider: "beta", method: "oauth", choiceId: "shared" }),
    ]);

    expect(resolveProviderChannelLoginChoice("shared", { metadataSnapshot: snapshot })).toEqual({
      status: "resolved",
      choice: expect.objectContaining({
        choiceId: "shared",
        pluginId: "test-provider",
        providerId: "beta",
      }),
    });
  });

  it("fails an equal-priority choice ID collision at the provider-login entry point", () => {
    const snapshot = {
      manifestRegistry: {
        plugins: [
          {
            id: "alpha-auth",
            origin: "bundled",
            providerAuthChoices: [
              choice({ provider: "alpha", method: "oauth", choiceId: "shared-login" }),
            ],
          },
          {
            id: "beta-auth",
            origin: "bundled",
            providerAuthChoices: [
              choice({ provider: "beta", method: "device", choiceId: "shared-login" }),
            ],
          },
        ],
      },
    } as never;

    expect(
      resolveProviderChannelLoginChoice("shared-login", { metadataSnapshot: snapshot }),
    ).toEqual({
      status: "ambiguous",
      choices: [
        expect.objectContaining({ pluginId: "alpha-auth", providerId: "alpha" }),
        expect.objectContaining({ pluginId: "beta-auth", providerId: "beta" }),
      ],
    });
  });

  it.each([
    {
      name: "provider id",
      input: "shared",
      choices: [
        choice({ provider: "shared", method: "one", choiceId: "shared-one" }),
        choice({ provider: "shared", method: "two", choiceId: "shared-two" }),
      ],
    },
    {
      name: "alias",
      input: "shared",
      choices: [
        choice({ provider: "one", method: "oauth", choiceId: "one", aliases: ["shared"] }),
        choice({ provider: "two", method: "oauth", choiceId: "two", aliases: ["shared"] }),
      ],
    },
    {
      name: "default",
      input: undefined,
      choices: [
        choice({ provider: "one", method: "oauth", choiceId: "one", default: true }),
        choice({ provider: "two", method: "oauth", choiceId: "two", default: true }),
      ],
    },
  ])("refuses a colliding $name", ({ input, choices }) => {
    const result = resolveProviderChannelLoginChoice(input, {
      metadataSnapshot: metadataSnapshot(choices),
    });

    expect(result.status).toBe("ambiguous");
    expect(
      result.status === "ambiguous" ? result.choices.map((entry) => entry.choiceId) : [],
    ).toEqual(choices.map((entry) => entry.choiceId));
  });

  it("excludes workspace manifests even when they declare channel login", () => {
    const result = resolveProviderChannelLoginChoice("workspace-provider", {
      metadataSnapshot: metadataSnapshot(
        [choice({ provider: "workspace-provider", method: "oauth", choiceId: "workspace" })],
        "workspace",
      ),
    });

    expect(result).toEqual({ status: "unsupported", choices: [] });
  });

  it.each([
    { label: "all plugins are disabled", plugins: { enabled: false } },
    { label: "the owner is denied", plugins: { deny: ["test-provider"] } },
    { label: "the owner is excluded by the allowlist", plugins: { allow: ["other-provider"] } },
    {
      label: "the owner entry is disabled",
      plugins: { entries: { "test-provider": { enabled: false } } },
    },
  ])("hides login choices when $label", ({ plugins }) => {
    const snapshot = metadataSnapshot([
      choice({ provider: "alpha", method: "oauth", choiceId: "alpha" }),
    ]);

    expect(
      resolveProviderChannelLoginChoice("alpha", {
        config: { plugins },
        metadataSnapshot: snapshot,
      }),
    ).toEqual({ status: "unsupported", choices: [] });
  });
});
