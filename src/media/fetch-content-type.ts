// Remote media content-type helpers arbitrate response headers and caller fallbacks.

export function isGenericResponseContentType(value?: string | null): boolean {
  const normalized = value?.split(";")[0]?.trim().toLowerCase();
  return (
    !normalized ||
    normalized === "application/octet-stream" ||
    normalized === "binary/octet-stream" ||
    normalized === "application/zip"
  );
}

export function resolveResponseContentType(params: {
  headerContentType?: string | null;
  fallbackContentType?: string;
}): string | undefined {
  if (!params.fallbackContentType) {
    return params.headerContentType ?? undefined;
  }
  if (isGenericResponseContentType(params.headerContentType)) {
    return params.fallbackContentType;
  }
  const headerContentType = params.headerContentType?.split(";")[0]?.trim().toLowerCase();
  const fallbackContentType = params.fallbackContentType.split(";")[0]?.trim().toLowerCase();
  // Some platforms mislabel audio/video container uploads by top-level type.
  // Preserve the caller hint when only that top-level prefix differs.
  if (
    headerContentType?.startsWith("video/") &&
    fallbackContentType?.startsWith("audio/") &&
    headerContentType.slice("video/".length) === fallbackContentType.slice("audio/".length)
  ) {
    return params.fallbackContentType;
  }
  return params.headerContentType ?? params.fallbackContentType;
}
