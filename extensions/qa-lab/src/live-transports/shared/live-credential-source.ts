type QaInferredCredentialSource = "convex" | "env";

export function inferQaCredentialSource(
  value: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): QaInferredCredentialSource {
  const normalized =
    value?.trim().toLowerCase() || env.OPENCLAW_QA_CREDENTIAL_SOURCE?.trim().toLowerCase();
  return normalized === "convex" ? "convex" : "env";
}
