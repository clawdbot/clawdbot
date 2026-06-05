/**
 * Shared mocks for auth profile OAuth tests.
 * Provides hoisted provider-runtime, CLI credential, doctor, and external CLI
 * sync mocks so OAuth tests can stay focused on store behavior.
 */
import { vi } from "vitest";
import type { OAuthCredential } from "./types.js";

const oauthProviderRuntimeMocks = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
}));

/** Return hoisted provider-runtime OAuth mocks for per-test setup. */
export function getOAuthProviderRuntimeMocks() {
  return oauthProviderRuntimeMocks;
}

vi.mock("../cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
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
