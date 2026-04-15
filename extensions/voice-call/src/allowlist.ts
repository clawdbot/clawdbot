export function normalizePhoneNumber(input?: string): string {
  if (!input) {
    return "";
  }
  return input.replace(/\D/g, "");
}

export function isAllowlistedCaller(
  normalizedFrom: string,
  allowFrom: string[] | undefined,
): boolean {
  if (!normalizedFrom) {
    return false;
  }
  return (allowFrom ?? []).some((num) => {
    const normalizedAllow = normalizePhoneNumber(num);
    return normalizedAllow !== "" && normalizedAllow === normalizedFrom;
  });
}
