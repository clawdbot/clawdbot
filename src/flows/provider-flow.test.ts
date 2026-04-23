import { beforeEach, describe, expect, it, vi } from "vitest";

type ResolveProviderInstallCatalogEntries =
  typeof import("../plugins/provider-install-catalog.js").resolveProviderInstallCatalogEntries;
type ResolveProviderWizardOptions =
  typeof import("../plugins/provider-wizard.js").resolveProviderWizardOptions;
type ResolveProviderModelPickerEntries =
  typeof import("../plugins/provider-wizard.js").resolveProviderModelPickerEntries;
type ResolvePluginProviders =
  typeof import("../plugins/providers.runtime.js").resolvePluginProviders;

const resolveProviderInstallCatalogEntries = vi.hoisted(() =>
  vi.fn<ResolveProviderInstallCatalogEntries>(() => []),
);
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries,
}));

const resolveProviderWizardOptions = vi.hoisted(() =>
  vi.fn<ResolveProviderWizardOptions>(() => []),
);
const resolveProviderModelPickerEntries = vi.hoisted(() =>
  vi.fn<ResolveProviderModelPickerEntries>(() => []),
);
vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderWizardOptions,
  resolveProviderModelPickerEntries,
}));

const resolvePluginProviders = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders,
}));

import {
  resolveProviderModelPickerFlowContributions,
  resolveProviderSetupFlowContributions,
} from "./provider-flow.js";

describe("provider flow install catalog contributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces install-catalog provider choices when runtime setup options are absent", () => {
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "vllm",
        providerId: "vllm",
        methodId: "server",
        choiceId: "vllm",
        choiceLabel: "vLLM",
        choiceHint: "Local server",
        groupId: "vllm",
        groupLabel: "vLLM",
        onboardingScopes: ["text-inference"],
        label: "vLLM",
        origin: "bundled",
        install: {
          npmSpec: "@openclaw/vllm",
        },
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        id: "provider:setup:vllm",
        kind: "provider",
        surface: "setup",
        providerId: "vllm",
        pluginId: "vllm",
        option: {
          value: "vllm",
          label: "vLLM",
          hint: "Local server",
          group: {
            id: "vllm",
            label: "vLLM",
          },
        },
        onboardingScopes: ["text-inference"],
        source: "install-catalog",
      },
    ]);
    expect(resolveProviderInstallCatalogEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
  });

  it("adds a fallback group when install-catalog entries omit group metadata", () => {
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "demo-provider",
        providerId: "demo-provider",
        methodId: "api-key",
        choiceId: "demo-provider-api-key",
        choiceLabel: "Demo Provider API key",
        label: "Demo Provider API key",
        origin: "global",
        install: {
          npmSpec: "@vendor/demo-provider",
        },
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        id: "provider:setup:demo-provider-api-key",
        kind: "provider",
        surface: "setup",
        providerId: "demo-provider",
        pluginId: "demo-provider",
        option: {
          value: "demo-provider-api-key",
          label: "Demo Provider API key",
          group: {
            id: "demo-provider",
            label: "Demo Provider API key",
          },
        },
        source: "install-catalog",
      },
    ]);
  });

  it("hides install-catalog choices that cannot be enabled", () => {
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "blocked-provider",
        providerId: "blocked-provider",
        methodId: "api-key",
        choiceId: "blocked-provider-api-key",
        choiceLabel: "Blocked Provider API key",
        label: "Blocked Provider",
        origin: "global",
        install: {
          npmSpec: "@vendor/blocked-provider",
        },
      },
    ]);

    expect(
      resolveProviderSetupFlowContributions({
        config: {
          plugins: {
            enabled: false,
          },
        },
      }),
    ).toEqual([]);
  });

  it("hides install-catalog choices outside a configured plugin allowlist", () => {
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "blocked-provider",
        providerId: "blocked-provider",
        methodId: "api-key",
        choiceId: "blocked-provider-api-key",
        choiceLabel: "Blocked Provider API key",
        label: "Blocked Provider",
        origin: "global",
        install: {
          npmSpec: "@vendor/blocked-provider@1.2.3",
          expectedIntegrity: "sha512-blocked",
        },
      },
    ]);

    expect(
      resolveProviderSetupFlowContributions({
        config: {
          plugins: {
            allow: ["openai"],
          },
        },
      }),
    ).toEqual([]);
  });

  it("prefers runtime setup contributions over duplicate install-catalog entries", () => {
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "openai-api-key",
        label: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
      },
    ]);
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        label: "OpenAI",
        origin: "bundled",
        install: {
          npmSpec: "@openclaw/openai",
        },
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        id: "provider:setup:openai-api-key",
        kind: "provider",
        surface: "setup",
        providerId: "openai",
        option: {
          value: "openai-api-key",
          label: "OpenAI API key",
          group: {
            id: "openai",
            label: "OpenAI",
          },
        },
        source: "runtime",
      },
    ]);
  });

  it("keeps docs attached to runtime model-picker contributions", () => {
    resolvePluginProviders.mockReturnValue([
      {
        id: "openai",
        label: "OpenAI",
        docsPath: "/providers/openai",
        auth: [],
      },
    ]);
    resolveProviderModelPickerEntries.mockReturnValue([
      {
        value: "provider-plugin:openai:gpt-5.4",
        label: "GPT-5.4",
      },
    ]);

    expect(resolveProviderModelPickerFlowContributions()).toEqual([
      {
        id: "provider:model-picker:provider-plugin:openai:gpt-5.4",
        kind: "provider",
        surface: "model-picker",
        providerId: "openai",
        option: {
          value: "provider-plugin:openai:gpt-5.4",
          label: "GPT-5.4",
          docs: {
            path: "/providers/openai",
          },
        },
        source: "runtime",
      },
    ]);
  });
});
