import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  vi.resetModules();
});

type ResolveProviderInstallCatalogEntries =
  typeof import("../plugins/provider-install-catalog.js").resolveProviderInstallCatalogEntries;
type ResolveManifestProviderAuthChoices =
  typeof import("../plugins/provider-auth-choices.js").resolveManifestProviderAuthChoices;
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

const resolveManifestProviderAuthChoices = vi.hoisted(() =>
  vi.fn<ResolveManifestProviderAuthChoices>(() => []),
);
vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices,
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

import { resolveProviderSetupFlowContributions } from "./provider-flow.js";
import { resolveProviderModelPickerFlowContributions } from "./provider-flow.runtime.js";

describe("provider flow install catalog contributions", () => {
  beforeEach(() => {
    resolveManifestProviderAuthChoices.mockReset();
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolveProviderInstallCatalogEntries.mockReset();
    resolveProviderInstallCatalogEntries.mockReturnValue([]);
    resolveProviderWizardOptions.mockReset();
    resolveProviderWizardOptions.mockReturnValue([]);
    resolveProviderModelPickerEntries.mockReset();
    resolveProviderModelPickerEntries.mockReturnValue([]);
    resolvePluginProviders.mockReset();
    resolvePluginProviders.mockReturnValue([]);
  });

  it("surfaces manifest provider auth choices before setup runtime loads", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai-compatible",
        providerId: "openai-compatible",
        methodId: "api-key",
        choiceId: "openai-compatible-api-key",
        choiceLabel: "OpenAI-compatible API key",
        choiceHint: "Use a compatible endpoint",
        assistantPriority: -5,
        assistantVisibility: "visible",
        groupId: "openai-compatible",
        groupLabel: "OpenAI-compatible",
        groupHint: "Self-hosted and compatible providers",
        onboardingScopes: ["text-inference"],
      },
    ]);

    expect(resolveProviderSetupFlowContributions()).toEqual([
      {
        id: "provider:setup:openai-compatible-api-key",
        kind: "provider",
        surface: "setup",
        providerId: "openai-compatible",
        pluginId: "openai-compatible",
        option: {
          value: "openai-compatible-api-key",
          label: "OpenAI-compatible API key",
          hint: "Use a compatible endpoint",
          assistantPriority: -5,
          assistantVisibility: "visible",
          group: {
            id: "openai-compatible",
            label: "OpenAI-compatible",
            hint: "Self-hosted and compatible providers",
          },
        },
        onboardingScopes: ["text-inference"],
        source: "manifest",
      },
    ]);
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledWith(
      expect.objectContaining({
        includeUntrustedWorkspacePlugins: false,
      }),
    );
    expect(resolveProviderWizardOptions).not.toHaveBeenCalled();
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("prefers manifest setup contributions over duplicate install-catalog entries", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
      },
    ]);
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "Catalog OpenAI API key",
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
        pluginId: "openai",
        option: {
          value: "openai-api-key",
          label: "OpenAI API key",
          group: {
            id: "openai",
            label: "OpenAI API key",
          },
        },
        source: "manifest",
      },
    ]);
    expect(resolveProviderWizardOptions).not.toHaveBeenCalled();
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

  it("keeps setup contributions on cold metadata instead of runtime wizard options", () => {
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
        pluginId: "openai",
        option: {
          value: "openai-api-key",
          label: "OpenAI API key",
          group: {
            id: "openai",
            label: "OpenAI",
          },
        },
        source: "install-catalog",
      },
    ]);
    expect(resolveProviderWizardOptions).not.toHaveBeenCalled();
    expect(resolvePluginProviders).not.toHaveBeenCalled();
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
