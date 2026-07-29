/** Covers provider registration validation for ids, duplicates, and required hooks. */
import { describe, expect, it } from "vitest";
import type { PluginDiagnostic } from "./manifest-types.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import type { ProviderPlugin } from "./types.js";

function collectDiagnostics() {
  const diagnostics: PluginDiagnostic[] = [];
  return {
    diagnostics,
    pushDiagnostic: (diag: PluginDiagnostic) => {
      diagnostics.push(diag);
    },
  };
}

function makeProvider(overrides: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: "demo",
    label: "Demo",
    auth: [],
    ...overrides,
  };
}

function expectDiagnosticMessages(
  diagnostics: PluginDiagnostic[],
  expectedDiagnostics: ReadonlyArray<{ level: PluginDiagnostic["level"]; message: string }>,
) {
  expect(diagnostics.map((diag) => ({ level: diag.level, message: diag.message }))).toEqual(
    expectedDiagnostics,
  );
}

function expectDiagnosticText(diagnostics: PluginDiagnostic[], messages: readonly string[]) {
  expect(diagnostics.map((diag) => diag.message)).toEqual([...messages]);
}

function normalizeProviderFixture(provider: ProviderPlugin) {
  const { diagnostics, pushDiagnostic } = collectDiagnostics();
  const normalizedProvider = normalizeRegisteredProvider({
    pluginId: "demo-plugin",
    source: "/tmp/demo/index.ts",
    provider,
    pushDiagnostic,
  });
  return {
    diagnostics,
    provider: normalizedProvider,
  };
}

function expectNormalizedProviderFixture(params: {
  provider: ProviderPlugin;
  expectedProvider?: unknown;
  expectedDiagnostics?: ReadonlyArray<{ level: PluginDiagnostic["level"]; message: string }>;
  expectedDiagnosticText?: readonly string[];
}) {
  const result = normalizeProviderFixture(params.provider);
  if (params.expectedProvider) {
    expect(result.provider).toEqual(params.expectedProvider);
  }
  if (params.expectedDiagnostics) {
    expectDiagnosticMessages(result.diagnostics, params.expectedDiagnostics);
  }
  if (params.expectedDiagnosticText) {
    expectDiagnosticText(result.diagnostics, params.expectedDiagnosticText);
  }
  return result;
}

function expectProviderNormalizationResult(params: {
  provider: ProviderPlugin;
  expectedProvider?: unknown;
  expectedDiagnostics?: ReadonlyArray<{ level: PluginDiagnostic["level"]; message: string }>;
  expectedDiagnosticText?: readonly string[];
  assert?: (
    provider: ReturnType<typeof normalizeRegisteredProvider>,
    diagnostics: PluginDiagnostic[],
    inputProvider: ProviderPlugin,
  ) => void;
}) {
  const { diagnostics, provider } = expectNormalizedProviderFixture(params);
  params.assert?.(provider, diagnostics, params.provider);
}

describe("normalizeRegisteredProvider", () => {
  const primaryAuthRun = async () => ({ profiles: [] });

  const cases = [
    {
      name: "drops invalid and duplicate auth methods, and clears bad wizard method bindings",
      provider: makeProvider({
        id: " demo ",
        label: " Demo Provider ",
        aliases: [" alias-one ", "alias-one", ""],
        deprecatedProfileIds: [" demo:legacy ", "demo:legacy", ""],
        envVars: [" DEMO_API_KEY ", "DEMO_API_KEY"],
        auth: [
          {
            id: " primary ",
            label: " Primary ",
            kind: "custom",
            wizard: {
              choiceId: " demo-primary ",
              onboardingFeatured: true,
              modelAllowlist: {
                allowedKeys: [" demo/model ", "demo/model"],
                initialSelections: [" demo/model "],
                loadCatalog: true,
                message: " Demo models ",
              },
            },
            run: primaryAuthRun,
          },
          {
            id: "primary",
            label: "Duplicate",
            kind: "custom",
            run: async () => ({ profiles: [] }),
          },
          { id: "   ", label: "Missing", kind: "custom", run: async () => ({ profiles: [] }) },
        ],
        wizard: {
          setup: {
            choiceId: " demo-choice ",
            onboardingFeatured: true,
            methodId: " missing ",
          },
          modelPicker: {
            label: " Demo models ",
            methodId: " missing ",
          },
        },
      }),
      expectedProvider: makeProvider({
        id: "demo",
        label: "Demo Provider",
        aliases: ["alias-one"],
        deprecatedProfileIds: ["demo:legacy"],
        envVars: ["DEMO_API_KEY"],
        auth: [
          {
            id: "primary",
            label: "Primary",
            kind: "custom",
            wizard: {
              choiceId: "demo-primary",
              onboardingFeatured: true,
              modelAllowlist: {
                allowedKeys: ["demo/model"],
                initialSelections: ["demo/model"],
                loadCatalog: true,
                message: "Demo models",
              },
            },
            run: primaryAuthRun,
          },
        ],
        wizard: {
          setup: {
            choiceId: "demo-choice",
            onboardingFeatured: true,
          },
          modelPicker: {
            label: "Demo models",
          },
        },
      }),
      expectedDiagnostics: [
        {
          level: "error",
          message: 'provider "demo" auth method duplicated id "primary"',
        },
        {
          level: "error",
          message: 'provider "demo" auth method missing id',
        },
        {
          level: "warn",
          message:
            'provider "demo" setup method "missing" not found; falling back to available methods',
        },
        {
          level: "warn",
          message:
            'provider "demo" model-picker method "missing" not found; falling back to available methods',
        },
      ],
    },
    {
      name: "drops wizard metadata when a provider has no auth methods",
      provider: makeProvider({
        wizard: {
          setup: {
            choiceId: "demo",
          },
          modelPicker: {
            label: "Demo",
          },
        },
      }),
      assert: (
        provider: ReturnType<typeof normalizeRegisteredProvider>,
        diagnostics: PluginDiagnostic[],
      ) => {
        expect(provider?.wizard).toBeUndefined();
        expectDiagnosticText(diagnostics, [
          'provider "demo" setup metadata ignored because it has no auth methods',
          'provider "demo" model-picker metadata ignored because it has no auth methods',
        ]);
      },
    },
  ] satisfies readonly (Parameters<typeof expectProviderNormalizationResult>[0] & {
    name: string;
  })[];

  it.each(cases)("$name", (testCase) => {
    expectProviderNormalizationResult(testCase);
  });
});
