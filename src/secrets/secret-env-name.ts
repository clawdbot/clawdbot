/** Matches environment names whose suffix convention indicates credential material. */
export const SECRET_ENV_NAME_RE = /_?(API_KEY|TOKEN|PASSWORD|PRIVATE_KEY|SECRET)$/i;

/** Classifies the default secret-store kind from an environment-style name. */
export function isSensitiveEnvName(name: string): boolean {
  return SECRET_ENV_NAME_RE.test(name);
}
