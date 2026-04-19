import { vi } from "vitest";
import type { OAuthCredential } from "./types.js";

const oauthProviderRuntimeMocks = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
}));

export function getOAuthProviderRuntimeMocks() {
  return oauthProviderRuntimeMocks;
}

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
  writeCodexCliCredentials: () => true,
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    oauthProviderRuntimeMocks.formatProviderAuthProfileApiKeyWithPluginMock() ??
    params?.context?.access,
  refreshProviderOAuthCredentialWithPlugin:
    oauthProviderRuntimeMocks.refreshProviderOAuthCredentialWithPluginMock,
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: async () => undefined,
}));

vi.mock("./external-cli-sync.js", () => ({
  areOAuthCredentialsEquivalent: (a: unknown, b: unknown) => a === b,
  hasUsableOAuthCredential: (credential: OAuthCredential | undefined, now = Date.now()) =>
    credential?.type === "oauth" &&
    credential.access.trim().length > 0 &&
    Number.isFinite(credential.expires) &&
    credential.expires - now > 5 * 60 * 1000,
  isSafeToUseExternalCliCredential: () => true,
  readExternalCliBootstrapCredential: () => null,
  readManagedExternalCliCredential: () => null,
  resolveExternalCliAuthProfiles: () => [],
  shouldBootstrapFromExternalCliCredential: () => false,
  shouldReplaceStoredOAuthCredential: (existing: unknown, incoming: unknown) =>
    existing !== incoming,
}));
