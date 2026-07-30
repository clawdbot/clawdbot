/** Normalize a lifecycle CLI option name without its attached value. */
export function lifecycleOptionName(token: string): string {
  return token.trim().toLowerCase().replaceAll("`", "").replaceAll("^", "").split("=", 1)[0] ?? "";
}
