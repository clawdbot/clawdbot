import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setActiveDegradedSecretOwners,
  SecretSurfaceUnavailableError,
} from "../secrets/runtime-degraded-state.js";
import {
  githubApiToken,
  hasConfiguredGitHubApiCredential,
  readGitHubJsonResponse,
} from "./control-ui-github-api.js";

afterEach(() => {
  setActiveDegradedSecretOwners([]);
  vi.restoreAllMocks();
});

describe("Control UI GitHub credential", () => {
  it("keeps the explicit preview credential separate and preserves ambient fallback by omission", () => {
    const env = { GH_TOKEN: "ambient-gh", GITHUB_TOKEN: "ambient-github" };

    expect(githubApiToken(env, {})).toBe("ambient-gh");
    expect(
      githubApiToken(env, {
        gateway: { controlUi: { github: { token: "preview-service-token" } } },
        tools: {
          github: {
            profileId: "ghp_99999999999999999999999999999999",
          },
        },
      }),
    ).toBe("preview-service-token");
    expect(() =>
      githubApiToken(env, {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "PREVIEW_TOKEN" },
            },
          },
        },
      }),
    ).toThrow(SecretSurfaceUnavailableError);
  });

  it("fails closed for an explicitly configured cold SecretRef owner", () => {
    const config = {
      gateway: {
        controlUi: {
          github: {
            token: { source: "store" as const, provider: "default", id: "PREVIEW_TOKEN" },
          },
        },
      },
    };
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "control-ui-github",
        state: "unavailable",
        degradationState: "cold",
        paths: ["gateway.controlUi.github.token"],
        refKeys: ["store:default:PREVIEW_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);

    expect(() => githubApiToken({ GH_TOKEN: "ambient" }, config)).toThrow(
      SecretSurfaceUnavailableError,
    );
    expect(hasConfiguredGitHubApiCredential({}, config)).toBe(true);
    expect(githubApiToken({ GH_TOKEN: "ambient" }, {})).toBe("ambient");
  });
});

describe("GitHub rate-limit retry timing", () => {
  it("prefers Retry-After over the primary reset header", async () => {
    const now = Date.parse("2026-08-23T10:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const response = new Response("rate limited", {
      status: 403,
      headers: {
        "retry-after": "120",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(now / 1_000) + 30),
      },
    });

    await expect(readGitHubJsonResponse(response)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 120_000,
    });
  });

  it("uses the primary reset epoch when Retry-After is absent", async () => {
    const now = Date.parse("2026-08-23T10:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const response = new Response("rate limited", {
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(now / 1_000) + 30),
      },
    });

    await expect(readGitHubJsonResponse(response)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 30_000,
    });
  });

  it("uses a bounded one-minute fallback without usable headers", async () => {
    await expect(
      readGitHubJsonResponse(new Response("rate limited", { status: 429 })),
    ).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
  });

  it("rejects malformed delta-seconds instead of interpreting exponent notation", async () => {
    const now = Date.parse("2026-08-23T10:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const response = new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "1e2" },
    });

    await expect(readGitHubJsonResponse(response)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
  });

  it("does not use the primary reset while secondary limiting leaves quota", async () => {
    const now = Date.parse("2026-08-23T10:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const response = new Response("secondary rate limit", {
      status: 429,
      headers: {
        "x-ratelimit-remaining": "42",
        "x-ratelimit-reset": String(Math.floor(now / 1_000) + 3_600),
      },
    });

    await expect(readGitHubJsonResponse(response)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
  });
});
