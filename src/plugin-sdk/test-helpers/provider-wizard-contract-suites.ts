import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuthMethod } from "../plugin-entry.js";
import type { ProviderPlugin } from "../provider-model-shared.js";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoice,
  resolveProviderWizardOptions,
  setProviderWizardProvidersResolverForTest,
} from "../testing.js";

const resolvePluginProvidersMock = vi.fn();
let restoreProviderResolver: (() => void) | undefined;

function createAuthMethod(
  params: Pick<ProviderAuthMethod, "id" | "label"> &
    Partial<Pick<ProviderAuthMethod, "hint" | "wizard">>,
): ProviderAuthMethod {
  return {
    id: params.id,
    label: params.label,
    ...(params.hint ? { hint: params.hint } : {}),
    ...(params.wizard ? { wizard: params.wizard } : {}),
    kind: "api_key",
    run: async () => ({ profiles: [] }),
  };
}

const TEST_PROVIDERS: ProviderPlugin[] = [
  {
    id: "alpha",
    label: "Alpha",
    auth: [
      createAuthMethod({
        id: "api-key",
        label: "API key",
        wizard: {
          choiceLabel: "Alpha key",
          choiceHint: "Use an API key",
          groupId: "alpha",
          groupLabel: "Alpha",
          onboardingScopes: ["text-inference"],
        },
      }),
      createAuthMethod({
        id: "oauth",
        label: "OAuth",
        wizard: {
          choiceId: "alpha-oauth",
          choiceLabel: "Alpha OAuth",
          groupId: "alpha",
          groupLabel: "Alpha",
          groupHint: "Recommended",
        },
      }),
    ],
    wizard: {
      modelPicker: {
        label: "Alpha custom",
        hint: "Pick Alpha models",
        methodId: "oauth",
      },
    },
  },
  {
    id: "beta",
    label: "Beta",
    auth: [createAuthMethod({ id: "token", label: "Token" })],
    wizard: {
      setup: {
        choiceLabel: "Beta setup",
        groupId: "beta",
        groupLabel: "Beta",
      },
      modelPicker: {
        label: "Beta custom",
      },
    },
  },
  {
    id: "gamma",
    label: "Gamma",
    auth: [
      createAuthMethod({ id: "default", label: "Default auth" }),
      createAuthMethod({ id: "alt", label: "Alt auth" }),
    ],
    wizard: {
      setup: {
        methodId: "alt",
        choiceId: "gamma-alt",
        choiceLabel: "Gamma alt",
        groupId: "gamma",
        groupLabel: "Gamma",
      },
    },
  },
];

const TEST_PROVIDER_IDS = TEST_PROVIDERS.map((provider) => provider.id).toSorted((left, right) =>
  left.localeCompare(right),
);

function sortedValues(values: readonly string[]) {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function expectUniqueValues(values: readonly string[]) {
  expect(values).toEqual([...new Set(values)]);
}

function resolveExpectedWizardChoiceValues(providers: ProviderPlugin[]) {
  return sortedValues(
    providers.flatMap((provider) => {
      const methodSetups = provider.auth.filter((method) => method.wizard);
      if (methodSetups.length > 0) {
        return methodSetups.map(
          (method) =>
            method.wizard?.choiceId?.trim() ||
            buildProviderPluginMethodChoice(provider.id, method.id),
        );
      }

      const setup = provider.wizard?.setup;
      if (!setup) {
        return [];
      }

      const explicitMethodId = setup.methodId?.trim();
      if (explicitMethodId && provider.auth.some((method) => method.id === explicitMethodId)) {
        return [
          setup.choiceId?.trim() || buildProviderPluginMethodChoice(provider.id, explicitMethodId),
        ];
      }

      if (provider.auth.length === 1) {
        return [setup.choiceId?.trim() || provider.id];
      }

      return provider.auth.map((method) => buildProviderPluginMethodChoice(provider.id, method.id));
    }),
  );
}

function resolveExpectedModelPickerValues(providers: ProviderPlugin[]) {
  return sortedValues(
    providers.flatMap((provider) => {
      const modelPicker = provider.wizard?.modelPicker;
      if (!modelPicker) {
        return [];
      }
      const explicitMethodId = modelPicker.methodId?.trim();
      if (explicitMethodId) {
        return [buildProviderPluginMethodChoice(provider.id, explicitMethodId)];
      }
      if (provider.auth.length === 1) {
        return [provider.id];
      }
      return [buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default")];
    }),
  );
}

function expectAllChoicesResolve(
  values: readonly string[],
  resolver: (choice: string) => ReturnType<typeof resolveProviderPluginChoice>,
) {
  expect(
    values.every((value) => Boolean(resolver(value))),
    values.join(", "),
  ).toBe(true);
}

beforeEach(() => {
  resolvePluginProvidersMock.mockReset();
  resolvePluginProvidersMock.mockReturnValue(TEST_PROVIDERS);
  restoreProviderResolver?.();
  restoreProviderResolver = setProviderWizardProvidersResolverForTest((params) =>
    resolvePluginProvidersMock(params),
  );
});

afterEach(() => {
  restoreProviderResolver?.();
  restoreProviderResolver = undefined;
});

export function describeProviderWizardSetupOptionsContract() {
  describe("provider wizard setup options contract", () => {
    it("exposes every wizard setup choice through the shared wizard layer", () => {
      const options = resolveProviderWizardOptions({
        config: {
          plugins: {
            enabled: true,
            allow: TEST_PROVIDER_IDS,
            slots: {
              memory: "none",
            },
          },
        },
        env: process.env,
      });

      expect(sortedValues(options.map((option) => option.value))).toEqual(
        resolveExpectedWizardChoiceValues(TEST_PROVIDERS),
      );
      expectUniqueValues(options.map((option) => option.value));
    });
  });
}

export function describeProviderWizardChoiceResolutionContract() {
  describe("provider wizard choice resolution contract", () => {
    it("round-trips every shared wizard choice back to its provider and auth method", () => {
      const options = resolveProviderWizardOptions({ config: {}, env: process.env });

      expectAllChoicesResolve(
        options.map((option) => option.value),
        (choice) =>
          resolveProviderPluginChoice({
            providers: TEST_PROVIDERS,
            choice,
          }),
      );
    });
  });
}

export function describeProviderWizardModelPickerContract() {
  describe("provider wizard model picker contract", () => {
    it("exposes every model-picker entry through the shared wizard layer", () => {
      const entries = resolveProviderModelPickerEntries({ config: {}, env: process.env });

      expect(sortedValues(entries.map((entry) => entry.value))).toEqual(
        resolveExpectedModelPickerValues(TEST_PROVIDERS),
      );
      expectAllChoicesResolve(
        entries.map((entry) => entry.value),
        (choice) =>
          resolveProviderPluginChoice({
            providers: TEST_PROVIDERS,
            choice,
          }),
      );
    });
  });
}
