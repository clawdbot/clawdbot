import type { ModelCatalogProvider } from "../types.js";

export type OpenClawProviderIndexPluginInstall = {
  clawhubSpec?: string;
  npmSpec?: string;
  defaultChoice?: "clawhub" | "npm";
  minHostVersion?: string;
  expectedIntegrity?: string;
};

export type OpenClawProviderIndexPlugin = {
  id: string;
  package?: string;
  source?: string;
  install?: OpenClawProviderIndexPluginInstall;
};

export type OpenClawProviderIndexProviderAuthChoice = {
  method: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  onboardingScopes?: readonly ("text-inference" | "image-generation")[];
};

export type OpenClawProviderIndexProvider = {
  id: string;
  name: string;
  plugin: OpenClawProviderIndexPlugin;
  docs?: string;
  categories?: readonly string[];
  authChoices?: readonly OpenClawProviderIndexProviderAuthChoice[];
  previewCatalog?: ModelCatalogProvider;
};

export type OpenClawProviderIndex = {
  version: number;
  providers: Readonly<Record<string, OpenClawProviderIndexProvider>>;
};
