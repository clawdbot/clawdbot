import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/store.js";
import { resolvePreferredProviderForAuthChoice } from "../../plugins/provider-auth-choice-preference.js";
import { buildProviderPluginMethodChoice } from "../provider-wizard.js";
import type { ProviderPlugin } from "../types.js";

type ResolvePluginProviders =
  typeof import("../../plugins/provider-auth-choice.runtime.js").resolvePluginProviders;
type ResolveProviderPluginChoice =
  typeof import("../../plugins/provider-auth-choice.runtime.js").resolveProviderPluginChoice;
type RunProviderModelSelectedHook =
  typeof import("../../plugins/provider-auth-choice.runtime.js").runProviderModelSelectedHook;
const resolvePluginProvidersMock = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
const resolvePluginSetupProviderMock = vi.hoisted(() => vi.fn(() => undefined));
const resolveProviderPluginChoiceMock = vi.hoisted(() => vi.fn<ResolveProviderPluginChoice>());
const runProviderModelSelectedHookMock = vi.hoisted(() =>
  vi.fn<RunProviderModelSelectedHook>(async () => {}),
);
const runAuthMethodMock = vi.hoisted(() => vi.fn(async () => ({ profiles: [] })));

vi.mock("../../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders: resolvePluginProvidersMock,
  resolvePluginSetupProvider: resolvePluginSetupProviderMock,
  resolveProviderPluginChoice: resolveProviderPluginChoiceMock,
  runProviderModelSelectedHook: runProviderModelSelectedHookMock,
}));

function createAuthChoiceProvider(params: {
  providerId: string;
  label: string;
  methodId: string;
  methodLabel: string;
  kind: "oauth" | "api_key" | "custom";
}) {
  return {
    id: params.providerId,
    label: params.label,
    auth: [
      {
        id: params.methodId,
        label: params.methodLabel,
        hint:
          params.kind === "api_key"
            ? "Paste key"
            : params.kind === "custom"
              ? "No auth"
              : "Browser sign-in",
        kind: params.kind,
        run: runAuthMethodMock,
      },
    ],
  } satisfies ProviderPlugin;
}

async function expectPreferredProviderFallback(provider: ProviderPlugin) {
  resolvePluginProvidersMock.mockClear();
  resolvePluginProvidersMock.mockReturnValue([provider]);
  await expect(
    resolvePreferredProviderForAuthChoice({
      choice: buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default"),
    }),
  ).resolves.toBe(provider.id);
  expect(resolvePluginProvidersMock).toHaveBeenCalled();
}

describe("provider auth-choice contract", () => {
  beforeEach(() => {
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
    resolveProviderPluginChoiceMock.mockReset();
    resolveProviderPluginChoiceMock.mockImplementation(({ providers, choice }) => {
      const provider = providers.find((entry) =>
        entry.auth.some(
          (method) => buildProviderPluginMethodChoice(entry.id, method.id) === choice,
        ),
      );
      if (!provider) {
        return null;
      }
      const method =
        provider.auth.find(
          (entry) => buildProviderPluginMethodChoice(provider.id, entry.id) === choice,
        ) ?? null;
      return method ? { provider, method } : null;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
    resolveProviderPluginChoiceMock.mockReset();
    resolveProviderPluginChoiceMock.mockReturnValue(null);
    runProviderModelSelectedHookMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("maps provider-plugin choices through the shared preferred-provider fallback resolver", async () => {
    const pluginFallbackScenarios: ProviderPlugin[] = [
      createAuthChoiceProvider({
        providerId: "demo-oauth-provider",
        label: "Demo OAuth Provider",
        methodId: "oauth",
        methodLabel: "OAuth",
        kind: "oauth",
      }),
      createAuthChoiceProvider({
        providerId: "demo-browser-provider",
        label: "Demo Browser Provider",
        methodId: "portal",
        methodLabel: "Portal",
        kind: "oauth",
      }),
      createAuthChoiceProvider({
        providerId: "demo-api-key-provider",
        label: "Demo API Key Provider",
        methodId: "api-key",
        methodLabel: "API key",
        kind: "api_key",
      }),
      createAuthChoiceProvider({
        providerId: "demo-local-provider",
        label: "Demo Local Provider",
        methodId: "local",
        methodLabel: "Local",
        kind: "custom",
      }),
    ];

    for (const provider of pluginFallbackScenarios) {
      await expectPreferredProviderFallback(provider);
    }

    resolvePluginProvidersMock.mockClear();
    await expect(resolvePreferredProviderForAuthChoice({ choice: "unknown" })).resolves.toBe(
      undefined,
    );
    expect(resolvePluginProvidersMock).toHaveBeenCalled();
  });
});
