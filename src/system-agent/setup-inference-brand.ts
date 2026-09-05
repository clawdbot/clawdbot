export function resolveSetupInferenceCandidateBrandId(
  candidate: { kind: string; modelRef: string },
  providerId?: string,
): string | undefined {
  // Built-in CLI detection kinds are runtime identities, not display brands.
  if (candidate.kind === "claude-cli") {
    return "claude";
  }
  if (candidate.kind === "codex-cli") {
    return "openai";
  }
  return providerId?.trim() || candidate.modelRef.split("/", 1)[0]?.trim() || undefined;
}
