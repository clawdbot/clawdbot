export type HttpContentEncoding = "br" | "gzip";
export type HttpRepresentationEncoding = HttpContentEncoding | "identity";

const HTTP_QVALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

function normalizedAcceptEncoding(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

export function resolveHttpContentEncodings(
  header: string | string[] | undefined,
  availableEncodings: ReadonlySet<HttpContentEncoding>,
): HttpRepresentationEncoding[] {
  const acceptEncoding = normalizedAcceptEncoding(header);
  if (!acceptEncoding.trim()) {
    return ["identity"];
  }
  const qualities = new Map<string, number>();
  for (const entry of acceptEncoding.split(",")) {
    const [rawName, ...rawParams] = entry.split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const qualityParam = rawParams.find((param) => param.trim().toLowerCase().startsWith("q="));
    const qualityText = qualityParam?.trim().slice(2);
    const parsedQuality =
      qualityText === undefined
        ? 1
        : HTTP_QVALUE_PATTERN.test(qualityText)
          ? Number(qualityText)
          : Number.NaN;
    const quality =
      Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
        ? parsedQuality
        : 0;
    qualities.set(name, Math.max(qualities.get(name) ?? 0, quality));
  }

  const wildcardQuality = qualities.get("*");
  // RFC 9110 keeps identity acceptable unless identity or a rejecting wildcard
  // explicitly disables it. This distinction is required to return 406 rather
  // than silently violate identity;q=0.
  const identityQuality = qualities.get("identity") ?? (wildcardQuality === 0 ? 0 : 1);
  const qualityFor = (name: HttpRepresentationEncoding) =>
    name === "identity" ? identityQuality : (qualities.get(name) ?? wildcardQuality ?? 0);
  // Stable sorting preserves the server's br/gzip/identity preference for equal quality.
  const encodings: HttpRepresentationEncoding[] = ["br", "gzip", "identity"];
  return encodings
    .filter(
      (encoding) =>
        (encoding === "identity" || availableEncodings.has(encoding)) && qualityFor(encoding) > 0,
    )
    .toSorted((left, right) => qualityFor(right) - qualityFor(left));
}
