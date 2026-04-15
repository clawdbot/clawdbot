export type WebFetchProviderPlugin = {
  id: string;
  label: string;
  hint: string;
  envVars: string[];
  placeholder?: string;
  signupUrl?: string;
  docsUrl?: string;
  autoDetectOrder?: number;
  credentialPath?: string;
  inactiveSecretPaths?: string[];
  getCredentialValue?: (fetchConfig?: Record<string, unknown>) => unknown;
  setCredentialValue?: (fetchConfigTarget: Record<string, unknown>, value: unknown) => void;
  getConfiguredCredentialValue?: (config?: unknown) => unknown;
  setConfiguredCredentialValue?: (configTarget: unknown, value: unknown) => void;
  applySelectionConfig?: (config: unknown) => unknown;
  createTool?: (ctx: unknown) => unknown;
};
