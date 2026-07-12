// Verifies marketplace feed and source profile config parsing.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

const ACME_ROOT_PUBLIC_KEY = "lHseHhZT8bJYRcI-1M9n7BBeC6trLjN1ccXKufO8WpY";
const ACME_BACKUP_PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ACME_ROOT_PUBLIC_KEY_PEM = [
  "-----BEGIN PUBLIC KEY-----",
  "MCowBQYDK2VwAyEAlHseHhZT8bJYRcI+1M9n7BBeC6trLjN1ccXKufO8WpY=",
  "-----END PUBLIC KEY-----",
].join("\n");

function expectMarketplacesConfig(value: unknown) {
  const result = OpenClawSchema.safeParse(value);
  if (!result.success) {
    throw new Error(JSON.stringify(result.error.issues, null, 2));
  }
  return result.data.marketplaces;
}

describe("OpenClawSchema marketplaces config", () => {
  it("accepts hosted feed and local source profiles", () => {
    const marketplaces = expectMarketplacesConfig({
      marketplaces: {
        feeds: {
          "clawhub-public": {
            url: "https://clawhub.ai/v1/feeds/plugins",
            verification: { mode: "unsigned" },
          },
          acme: {
            url: "https://packages.acme.example/openclaw/feed",
            verification: {
              mode: "signed",
              keys: [
                {
                  keyId: "acme-root-2026",
                  publicKey: ACME_ROOT_PUBLIC_KEY,
                },
                {
                  keyId: "acme-backup-2026",
                  publicKey: ACME_BACKUP_PUBLIC_KEY,
                },
              ],
              threshold: 2,
            },
          },
        },
        sources: {
          "public-clawhub": { type: "clawhub" },
          "public-npm": { type: "npm" },
          "acme-npm": { type: "npm" },
          "acme-clawhub": { type: "clawhub" },
          "acme-git": { type: "git" },
        },
      },
    });

    const acmeFeed = expectDefined(marketplaces?.feeds?.acme, "Acme marketplace feed");
    expect(acmeFeed.url).toBe("https://packages.acme.example/openclaw/feed");
    expect(acmeFeed.verification).toEqual({
      mode: "signed",
      keys: [
        {
          keyId: "acme-root-2026",
          publicKey: ACME_ROOT_PUBLIC_KEY,
        },
        {
          keyId: "acme-backup-2026",
          publicKey: ACME_BACKUP_PUBLIC_KEY,
        },
      ],
      threshold: 2,
    });
    expect(
      expectDefined(
        marketplaces?.sources?.["acme-git"],
        'marketplaces?.sources?.["acme-git"] test invariant',
      ).type,
    ).toBe("git");
  });

  it.each([
    "http://packages.acme.example/openclaw/feed",
    "https://token@packages.acme.example/openclaw/feed",
    "https://user:pass@packages.acme.example/openclaw/feed",
    "https://packages.acme.example/openclaw/feed?token=secret",
    "https://packages.acme.example/openclaw/feed#access-token",
    "not a url",
  ])("rejects invalid or auth-bearing hosted feed URL %s without throwing", (url) => {
    expect(() =>
      OpenClawSchema.safeParse({
        marketplaces: {
          feeds: { acme: { url } },
        },
      }),
    ).not.toThrow();
    const result = OpenClawSchema.safeParse({
      marketplaces: {
        feeds: { acme: { url } },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(
        "marketplaces.feeds.acme.url",
      );
    }
  });

  it("rejects refresh and auth until loader enforcement exists", () => {
    expect(
      OpenClawSchema.safeParse({
        marketplaces: {
          feeds: {
            acme: {
              url: "https://packages.acme.example/openclaw/feed",
              auth: { scheme: "bearer", secret: "token" },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      OpenClawSchema.safeParse({
        marketplaces: {
          feeds: {
            acme: {
              url: "https://packages.acme.example/openclaw/feed",
              refresh: { onStartup: "if-stale" },
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects signed feed verification without usable local trust anchors", () => {
    for (const verification of [
      { mode: "signed" },
      { mode: "signed", keys: [] },
      { mode: "signed", keys: [{ keyId: "", publicKey: "abc" }] },
      { mode: "signed", keys: [{ keyId: "acme-root", publicKey: "" }] },
      { mode: "signed", keys: [{ keyId: "acme-root", publicKey: "abc" }] },
      { mode: "signed", keys: [{ keyId: "acme-root", publicKey: `${ACME_ROOT_PUBLIC_KEY}!` }] },
      {
        mode: "signed",
        keys: [
          {
            keyId: "acme-root",
            publicKey:
              "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----",
          },
        ],
      },
      {
        mode: "signed",
        keys: [{ keyId: "acme-root", publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
        threshold: 0,
      },
      {
        mode: "signed",
        keys: [{ keyId: "acme-root", publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
        threshold: 2,
      },
    ]) {
      expect(
        OpenClawSchema.safeParse({
          marketplaces: {
            feeds: {
              acme: {
                url: "https://packages.acme.example/openclaw/feed",
                verification,
              },
            },
          },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects duplicate signed feed trust anchors", () => {
    for (const verification of [
      {
        mode: "signed",
        keys: [
          { keyId: "acme-root", publicKey: ACME_ROOT_PUBLIC_KEY },
          { keyId: "acme-root", publicKey: ACME_BACKUP_PUBLIC_KEY },
        ],
        threshold: 2,
      },
      {
        mode: "signed",
        keys: [
          { keyId: "acme-root-a", publicKey: ACME_ROOT_PUBLIC_KEY },
          { keyId: "acme-root-b", publicKey: ACME_ROOT_PUBLIC_KEY },
        ],
        threshold: 2,
      },
      {
        mode: "signed",
        keys: [
          { keyId: "acme-root-a", publicKey: ACME_ROOT_PUBLIC_KEY },
          { keyId: "acme-root-b", publicKey: ACME_ROOT_PUBLIC_KEY_PEM },
        ],
        threshold: 2,
      },
    ]) {
      const result = OpenClawSchema.safeParse({
        marketplaces: {
          feeds: {
            acme: {
              url: "https://packages.acme.example/openclaw/feed",
              verification,
            },
          },
        },
      });

      expect(result.success).toBe(false);
    }
  });

  it("rejects unknown source profile types", () => {
    const result = OpenClawSchema.safeParse({
      marketplaces: {
        sources: { acme: { type: "container" } },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects source endpoints until installer resolution can enforce them", () => {
    const result = OpenClawSchema.safeParse({
      marketplaces: {
        sources: {
          "acme-npm": { type: "npm", registry: "https://packages.acme.example/npm/" },
          "acme-clawhub": { type: "clawhub", baseUrl: "https://packages.acme.example/clawhub/" },
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
