type HostedMarketplaceFeedFixtureOptions = {
  source?: "hosted" | "hosted-snapshot";
  entries?: Record<string, unknown>[];
  url?: string;
  checksum?: string;
  etag?: string;
  includeTrust?: boolean;
};

export function createHostedMarketplaceFeedFixture(
  options: HostedMarketplaceFeedFixtureOptions = {},
) {
  const source = options.source ?? "hosted";
  const metadata = {
    url: options.url ?? "https://packages.acme.example/openclaw/feed",
    status: 200,
    checksum: options.checksum ?? "feed-sha",
    ...(options.etag ? { etag: options.etag } : {}),
  };
  const verifiedAt =
    source === "hosted-snapshot" ? "2026-06-23T01:02:03.000Z" : "2026-06-23T00:01:02.000Z";
  return {
    source,
    entries: options.entries ?? [],
    feed: {
      schemaVersion: 1,
      id: "acme-marketplace",
      generatedAt: "2026-06-23T00:00:00.000Z",
      sequence: 7,
      entries: [],
    },
    metadata,
    ...(source === "hosted-snapshot"
      ? {
          snapshot: { body: "{}", metadata, savedAt: verifiedAt },
          error: "hosted catalog feed offline mode",
        }
      : {}),
    ...(options.includeTrust !== false
      ? {
          trust: {
            mode: "signed" as const,
            signedBy: "acme-root-2026",
            signatureCount: 1,
            threshold: 1,
            verifiedAt,
          },
        }
      : {}),
  };
}
