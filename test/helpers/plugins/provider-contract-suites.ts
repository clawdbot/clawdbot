import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type {
  ProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "../../../src/plugins/types.js";

type Lazy<T> = T | (() => T);

type WebProviderCredentialContract = Pick<
  WebSearchProviderPlugin,
  | "createTool"
  | "docsUrl"
  | "envVars"
  | "getCredentialValue"
  | "hint"
  | "id"
  | "label"
  | "placeholder"
  | "setCredentialValue"
  | "signupUrl"
>;

function resolveLazy<T>(value: Lazy<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

function expectWebProviderCredentialContract(
  provider: WebProviderCredentialContract,
  credentialValue: unknown,
) {
  expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  expect(provider.label.trim()).not.toBe("");
  expect(provider.hint.trim()).not.toBe("");
  expect(provider.placeholder.trim()).not.toBe("");
  expect(provider.signupUrl.startsWith("https://")).toBe(true);
  if (provider.docsUrl) {
    expect(provider.docsUrl.startsWith("http")).toBe(true);
  }

  expect(provider.envVars).toEqual([...new Set(provider.envVars)]);
  expect(provider.envVars.every((entry) => entry.trim().length > 0)).toBe(true);

  const configTarget: Record<string, unknown> = {};
  provider.setCredentialValue(configTarget, credentialValue);
  expect(provider.getCredentialValue(configTarget)).toEqual(credentialValue);

  expect(typeof provider.createTool).toBe("function");
  return configTarget;
}

export function installProviderPluginContractSuite(params: { provider: Lazy<ProviderPlugin> }) {
  it("satisfies the base provider plugin contract", () => {
    const provider = resolveLazy(params.provider);
    const authIds = provider.auth.map((method) => method.id);
    const wizardChoiceIds = new Set<string>();

    expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(provider.label.trim()).not.toBe("");

    if (provider.docsPath) {
      expect(provider.docsPath.startsWith("/")).toBe(true);
    }
    if (provider.aliases) {
      expect(provider.aliases).toEqual([...new Set(provider.aliases)]);
    }
    if (provider.envVars) {
      expect(provider.envVars).toEqual([...new Set(provider.envVars)]);
      expect(provider.envVars.every((entry) => entry.trim().length > 0)).toBe(true);
    }

    expect(Array.isArray(provider.auth)).toBe(true);
    expect(authIds).toEqual([...new Set(authIds)]);
    for (const method of provider.auth) {
      expect(method.id.trim()).not.toBe("");
      expect(method.label.trim()).not.toBe("");
      if (method.hint !== undefined) {
        expect(method.hint.trim()).not.toBe("");
      }
      if (method.wizard) {
        if (method.wizard.choiceId) {
          expect(method.wizard.choiceId.trim()).not.toBe("");
          expect(wizardChoiceIds.has(method.wizard.choiceId)).toBe(false);
          wizardChoiceIds.add(method.wizard.choiceId);
        }
        if (method.wizard.methodId) {
          expect(authIds).toContain(method.wizard.methodId);
        }
        if (method.wizard.modelAllowlist?.allowedKeys) {
          expect(method.wizard.modelAllowlist.allowedKeys).toEqual([
            ...new Set(method.wizard.modelAllowlist.allowedKeys),
          ]);
        }
        if (method.wizard.modelAllowlist?.initialSelections) {
          expect(method.wizard.modelAllowlist.initialSelections).toEqual([
            ...new Set(method.wizard.modelAllowlist.initialSelections),
          ]);
        }
      }
      expect(typeof method.run).toBe("function");
    }

    if (provider.wizard?.setup || provider.wizard?.modelPicker) {
      expect(provider.auth.length).toBeGreaterThan(0);
    }
    if (provider.wizard?.setup) {
      if (provider.wizard.setup.choiceId) {
        expect(provider.wizard.setup.choiceId.trim()).not.toBe("");
        expect(wizardChoiceIds.has(provider.wizard.setup.choiceId)).toBe(false);
      }
      if (provider.wizard.setup.methodId) {
        expect(authIds).toContain(provider.wizard.setup.methodId);
      }
      if (provider.wizard.setup.modelAllowlist?.allowedKeys) {
        expect(provider.wizard.setup.modelAllowlist.allowedKeys).toEqual([
          ...new Set(provider.wizard.setup.modelAllowlist.allowedKeys),
        ]);
      }
      if (provider.wizard.setup.modelAllowlist?.initialSelections) {
        expect(provider.wizard.setup.modelAllowlist.initialSelections).toEqual([
          ...new Set(provider.wizard.setup.modelAllowlist.initialSelections),
        ]);
      }
    }
    if (provider.wizard?.modelPicker?.methodId) {
      expect(authIds).toContain(provider.wizard.modelPicker.methodId);
    }
  });
}

export function installWebSearchProviderContractSuite(params: {
  provider: Lazy<WebSearchProviderPlugin>;
  credentialValue: Lazy<unknown>;
}) {
  it("satisfies the base web search provider contract", () => {
    const provider = resolveLazy(params.provider);
    const credentialValue = resolveLazy(params.credentialValue);

    const searchConfigTarget = expectWebProviderCredentialContract(provider, credentialValue);
    expect(provider.getCredentialValue(searchConfigTarget)).toEqual(credentialValue);
    if (provider.runSetup) {
      expect(typeof provider.runSetup).toBe("function");
    }
  });
}

export function installWebFetchProviderContractSuite(params: {
  provider: Lazy<WebFetchProviderPlugin>;
  credentialValue: Lazy<unknown>;
  pluginId?: string;
}) {
  it("satisfies the base web fetch provider contract", () => {
    const provider = resolveLazy(params.provider);
    const credentialValue = resolveLazy(params.credentialValue);

    expectWebProviderCredentialContract(provider, credentialValue);
    expect(provider.credentialPath.trim()).not.toBe("");
    if (provider.inactiveSecretPaths) {
      expect(provider.inactiveSecretPaths).toEqual([...new Set(provider.inactiveSecretPaths)]);
      expect(provider.inactiveSecretPaths).toContain(provider.credentialPath);
    }

    const fetchConfigTarget: Record<string, unknown> = {};
    provider.setCredentialValue(fetchConfigTarget, credentialValue);
    expect(provider.getCredentialValue(fetchConfigTarget)).toEqual(credentialValue);

    if (provider.setConfiguredCredentialValue && provider.getConfiguredCredentialValue) {
      const configTarget = {} as OpenClawConfig;
      provider.setConfiguredCredentialValue(configTarget, credentialValue);
      expect(provider.getConfiguredCredentialValue(configTarget)).toEqual(credentialValue);
    }

    if (provider.applySelectionConfig && params.pluginId) {
      const applied = provider.applySelectionConfig({} as OpenClawConfig);
      expect(applied.plugins?.entries?.[params.pluginId]?.enabled).toBe(true);
    }
  });
}
