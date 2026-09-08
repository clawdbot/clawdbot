/**
 * Core-internal auth policy for bundled auth-owning CLI backends. Membership controls
 * selected-profile resolution and raw credential forwarding during prepareExecution;
 * third-party plugins cannot declare this trust decision through Plugin SDK metadata.
 */
export type BundledCliBackendAuthPolicy = {
  /** Disable profile fallback and fail closed when the selected profile cannot materialize. */
  strictSelectedProfile: boolean;
  /** Owner responsible for refreshing selected OAuth credentials before execution. */
  oauthRefreshOwner: "core" | "cli";
  /** Retired OAuth profile identities that the native runtime owns instead. */
  nativeAuthProfileIds?: readonly string[];
};

const BUNDLED_CLI_BACKEND_AUTH_POLICIES = {
  "claude-cli": {
    strictSelectedProfile: true,
    oauthRefreshOwner: "core",
    nativeAuthProfileIds: ["anthropic:claude-cli"],
  },
  "google-gemini-cli": {
    strictSelectedProfile: false,
    oauthRefreshOwner: "cli",
  },
} satisfies Record<string, BundledCliBackendAuthPolicy>;

export function resolveBundledCliBackendAuthPolicy(
  backendId: string,
): BundledCliBackendAuthPolicy | undefined {
  return BUNDLED_CLI_BACKEND_AUTH_POLICIES[
    backendId as keyof typeof BUNDLED_CLI_BACKEND_AUTH_POLICIES
  ];
}
