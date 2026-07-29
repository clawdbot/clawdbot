export function normalizeSessionIdentities(
  scope: string,
  identities: Iterable<string | undefined>,
): string[] {
  const normalizedScope = scope.trim();
  if (!normalizedScope) {
    throw new Error("session lifecycle scope is required");
  }
  return Array.from(
    new Set(
      Array.from(identities, (identity) => identity?.trim()).filter(
        (identity): identity is string => Boolean(identity),
      ),
    ),
  )
    .map((identity) => JSON.stringify([normalizedScope, identity]))
    .toSorted();
}

export function decodeSessionIdentity(
  normalizedIdentity: string,
): { scope: string; identity: string } | undefined {
  try {
    const decoded: unknown = JSON.parse(normalizedIdentity);
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      typeof decoded[1] !== "string"
    ) {
      return undefined;
    }
    return { scope: decoded[0], identity: decoded[1] };
  } catch {
    return undefined;
  }
}
