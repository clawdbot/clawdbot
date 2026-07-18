// Covers the promotions feed cache: refresh cadence, 304 revalidation,
// sequence monotonicity, notified markers, and claim provenance.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { useMockHttp } from "../test-utils/mock-http.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  listLivePromotionEntries,
  markPromotionSlugsNotified,
  maybeRefreshPromotionsFeed,
  readPromotionClaims,
  recordPromotionClaim,
} from "./promotions-feed.js";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const FEED_URL = "https://clawhub.ai/api/v1/feeds/promotions";
const mockHttp = useMockHttp();

function feedPayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "clawhub-promotions",
    generatedAt: "2026-07-05T00:00:00.000Z",
    sequence: 4,
    expiresAt: "2026-07-06T00:00:00.000Z",
    entries: [
      {
        type: "promotion",
        slug: "example-models-launch",
        title: "Free Example models",
        blurb: "Limited-time offer.",
        startsAt: NOW - 86_400_000,
        endsAt: NOW + 86_400_000,
        provider: "example-provider",
        authChoiceId: "example-provider-api-key",
        models: [{ modelRef: "example-provider/example/model-alpha", alias: "model-alpha" }],
      },
    ],
    ...overrides,
  };
}

describe("promotions feed state", () => {
  let testState: OpenClawTestState;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-promotions-feed-",
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  it("round-trips a fetched snapshot while the last check is fresh", async () => {
    mockHttp.intercept({
      url: FEED_URL,
      reply: { json: feedPayload(), headers: { etag: '"v4"' } },
    });
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });
    const second = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      fetchImpl: globalThis.fetch,
    });
    expect(mockHttp.requests()).toHaveLength(1);
    expect(second.sequence).toBe(4);
    expect(second.etag).toBe('"v4"');
    expect(second.expiresAtMs).toBe(Date.parse("2026-07-06T00:00:00.000Z"));
    expect(second.entries[0]?.slug).toBe("example-models-launch");
    expect(listLivePromotionEntries(second, NOW)).toHaveLength(1);
    expect(listLivePromotionEntries(second, NOW + 3 * 86_400_000)).toHaveLength(0);
  });

  it("refreshes at feed expiry and keeps an expired 304 snapshot hidden without retrying", async () => {
    const expiresAt = new Date(NOW + 60_000).toISOString();
    mockHttp.intercept({
      url: FEED_URL,
      reply: { json: feedPayload({ expiresAt }), headers: { etag: '"v4"' } },
    });
    mockHttp.intercept({
      url: FEED_URL,
      requestHeaders: { "if-none-match": '"v4"' },
      reply: { status: 304 },
    });
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });

    const expired = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      fetchImpl: globalThis.fetch,
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(listLivePromotionEntries(expired, NOW + 60_000)).toHaveLength(0);

    const cached = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 61_000,
      fetchImpl: globalThis.fetch,
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(cached.lastCheckedAtMs).toBe(NOW + 60_000);
    expect(listLivePromotionEntries(cached, NOW + 61_000)).toHaveLength(0);
  });

  it("keeps an expired snapshot hidden after a failed expiry refresh without retrying", async () => {
    const expiresAt = new Date(NOW + 60_000).toISOString();
    mockHttp.intercept({ url: FEED_URL, reply: { json: feedPayload({ expiresAt }) } });
    mockHttp.intercept({ url: FEED_URL, reply: new Error("offline") });
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });

    const expired = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      fetchImpl: globalThis.fetch,
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(listLivePromotionEntries(expired, NOW + 60_000)).toHaveLength(0);

    const cached = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 61_000,
      fetchImpl: globalThis.fetch,
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(listLivePromotionEntries(cached, NOW + 61_000)).toHaveLength(0);
  });

  it("replaces an expired snapshot when ClawHub publishes a newer sequence", async () => {
    const firstExpiry = new Date(NOW + 60_000).toISOString();
    const nextExpiry = new Date(NOW + 86_400_000).toISOString();
    mockHttp.intercept({
      url: FEED_URL,
      reply: { json: feedPayload({ expiresAt: firstExpiry, sequence: 4 }) },
    });
    mockHttp.intercept({
      url: FEED_URL,
      reply: { json: feedPayload({ expiresAt: nextExpiry, sequence: 5 }) },
    });
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });

    const refreshed = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      fetchImpl: globalThis.fetch,
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(refreshed.sequence).toBe(5);
    expect(refreshed.expiresAtMs).toBe(Date.parse(nextExpiry));
    expect(listLivePromotionEntries(refreshed, NOW + 60_000)).toHaveLength(1);
  });

  it("drops a stale validator when the cached payload is invalid", async () => {
    mockHttp.intercept({
      url: FEED_URL,
      reply: { json: feedPayload(), headers: { etag: '"v4"' } },
    });
    mockHttp.intercept({
      url: FEED_URL,
      requestHeaders: (headers) =>
        !Object.keys(headers).some((name) => name.toLowerCase() === "if-none-match"),
      reply: { json: feedPayload({ sequence: 5 }), headers: { etag: '"v5"' } },
    });
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely =
        getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "clawhub_promotions_feed_state">>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("clawhub_promotions_feed_state")
          .set({ payload_json: "{invalid" })
          .where("state_key", "=", "default"),
      );
    });

    const state = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      fetchImpl: globalThis.fetch,
    });

    expect(state.sequence).toBe(5);
    expect(state.etag).toBe('"v5"');
    expect(state.entries).toHaveLength(1);
  });

  it("never replaces the cache with an older snapshot sequence", async () => {
    mockHttp.intercept({ url: FEED_URL, reply: { json: feedPayload({ sequence: 4 }) } });
    mockHttp.intercept({
      url: FEED_URL,
      reply: { json: feedPayload({ sequence: 2, entries: [] }) },
    });
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });
    const state = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      force: true,
      fetchImpl: globalThis.fetch,
    });
    expect(state.sequence).toBe(4);
    expect(state.entries).toHaveLength(1);
  });

  it("fails silent on network errors and keeps the cached snapshot", async () => {
    mockHttp.intercept({ url: FEED_URL, reply: { json: feedPayload() } });
    mockHttp.intercept({ url: FEED_URL, reply: new Error("offline") });
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });
    const state = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      force: true,
      fetchImpl: globalThis.fetch,
    });
    expect(state.entries).toHaveLength(1);
    // The failed attempt still stamps the check time so offline runs do not
    // retry on every command.
    expect(state.lastCheckedAtMs).toBe(NOW + 60_000);
  });

  it("keeps the cached snapshot when a refresh has calendar-invalid timestamps", async () => {
    mockHttp.intercept({
      url: FEED_URL,
      reply: { json: feedPayload(), headers: { etag: '"v4"' } },
    });
    mockHttp.intercept({
      url: FEED_URL,
      reply: {
        json: feedPayload({
          generatedAt: "2026-02-30T00:00:00.000Z",
          sequence: 5,
          entries: [],
        }),
        headers: { etag: '"v5"' },
      },
    });
    await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });

    const rejected = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 60_000,
      force: true,
      fetchImpl: globalThis.fetch,
    });
    expect(rejected.sequence).toBe(4);
    expect(rejected.etag).toBe('"v4"');
    expect(rejected.entries).toHaveLength(1);

    const cached = await maybeRefreshPromotionsFeed({
      nowMs: NOW + 61_000,
      fetchImpl: globalThis.fetch,
    });
    expect(mockHttp.requests()).toHaveLength(2);
    expect(cached.sequence).toBe(4);
    expect(cached.etag).toBe('"v4"');
    expect(cached.entries).toHaveLength(1);
  });

  it("persists and deduplicates notified promotion slugs", async () => {
    markPromotionSlugsNotified(["example-models-launch", "second-offer"]);
    markPromotionSlugsNotified(["example-models-launch"]);
    mockHttp.intercept({ url: FEED_URL, reply: { json: feedPayload() } });

    const state = await maybeRefreshPromotionsFeed({ nowMs: NOW, fetchImpl: globalThis.fetch });

    expect([...state.notifiedSlugs].toSorted()).toEqual(["example-models-launch", "second-offer"]);
  });

  it("round-trips claim provenance and upserts by slug", () => {
    recordPromotionClaim({
      slug: "example-models-launch",
      provider: "example-provider",
      modelKeys: ["example-provider/example/model-alpha"],
      endsAtMs: NOW + 86_400_000,
      claimedAtMs: NOW,
    });
    recordPromotionClaim({
      slug: "example-models-launch",
      provider: "example-provider",
      modelKeys: ["example-provider/example/model-alpha", "example-provider/example/model-beta"],
      endsAtMs: NOW + 2 * 86_400_000,
      claimedAtMs: NOW + 1,
    });
    const claims = readPromotionClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.modelKeys).toHaveLength(2);
    expect(claims[0]?.endsAtMs).toBe(NOW + 2 * 86_400_000);
  });
});
