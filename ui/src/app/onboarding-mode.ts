export function resolveOnboardingMode(search: string): boolean {
  const raw = new URLSearchParams(search).get("onboarding");
  return raw !== null && /^(?:1|true|yes|on)$/iu.test(raw.trim());
}
