// Googlechat ADC token tests prove two things: (1) the metadata-server token
// mint is routed through the SSRF guard and is inert without the scoped opt-in
// policy (default-deny), and (2) the token is parsed and cached correctly.
import {
  type LookupFn,
  resolvePinnedHostnameWithPolicy,
  SsrFBlockedError,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGoogleChatAdcAccessToken,
  getMetadataTokenPolicy,
  resetAdcTokenCacheForTests,
} from "./adc-token.js";

const METADATA_HOST = "metadata.google.internal";
const METADATA_IP = "169.254.169.254";
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";

const metadataLookup = (): LookupFn =>
  vi.fn(async () => [{ address: METADATA_IP, family: 4 }]) as unknown as LookupFn;

type GuardedFetch = NonNullable<Parameters<typeof getGoogleChatAdcAccessToken>[1]>["guardedFetch"];

function fakeGuardedFetch(
  body: unknown,
  init?: { status?: number },
): { fetch: GuardedFetch; calls: Array<{ url: string; policy: unknown; headers: Headers }> } {
  const calls: Array<{ url: string; policy: unknown; headers: Headers }> = [];
  const fetch = (async (params: {
    url: string;
    policy?: unknown;
    init?: { headers?: HeadersInit };
  }) => {
    calls.push({
      url: params.url,
      policy: params.policy,
      headers: new Headers(params.init?.headers),
    });
    return {
      response: new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: init?.status ?? 200,
      }),
      finalUrl: params.url,
      release: async () => {},
    };
  }) as unknown as GuardedFetch;
  return { fetch, calls };
}

describe("googlechat ADC metadata boundary", () => {
  it("blocks the metadata server by default (no opt-in policy)", async () => {
    await expect(
      resolvePinnedHostnameWithPolicy(METADATA_HOST, { lookupFn: metadataLookup() }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });

  it("permits the metadata server only with the scoped opt-in policy", async () => {
    const pinned = await resolvePinnedHostnameWithPolicy(METADATA_HOST, {
      lookupFn: metadataLookup(),
      policy: getMetadataTokenPolicy(),
    });
    expect(pinned.addresses).toContain(METADATA_IP);
  });

  it("scopes the opt-in to the metadata host and private network only", () => {
    expect(getMetadataTokenPolicy()?.allowPrivateNetwork).toBe(true);
    expect(getMetadataTokenPolicy()?.hostnameAllowlist).toContain(METADATA_HOST);
  });
});

describe("getGoogleChatAdcAccessToken", () => {
  beforeEach(() => {
    resetAdcTokenCacheForTests();
  });

  it("mints a token from the metadata server through the guard", async () => {
    const { fetch, calls } = fakeGuardedFetch({ access_token: "tok-1", expires_in: 3599 });

    const token = await getGoogleChatAdcAccessToken([CHAT_SCOPE], {
      guardedFetch: fetch,
      now: () => 0,
    });

    expect(token).toBe("tok-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(`http://${METADATA_HOST}/computeMetadata/v1/`);
    expect(calls[0]?.url).toContain(encodeURIComponent(CHAT_SCOPE));
    expect(calls[0]?.headers.get("Metadata-Flavor")).toBe("Google");
    expect(calls[0]?.policy).toBe(getMetadataTokenPolicy());
  });

  it("caches the token until shortly before expiry, then refreshes", async () => {
    const { fetch, calls } = fakeGuardedFetch({ access_token: "tok-1", expires_in: 3600 });
    let clock = 0;
    const deps = { guardedFetch: fetch, now: () => clock };

    expect(await getGoogleChatAdcAccessToken([CHAT_SCOPE], deps)).toBe("tok-1");
    // Well within the token lifetime: served from cache, no second fetch.
    clock = 60_000;
    expect(await getGoogleChatAdcAccessToken([CHAT_SCOPE], deps)).toBe("tok-1");
    expect(calls).toHaveLength(1);

    // Past expiry (minus skew): refreshed.
    const refreshed = fakeGuardedFetch({ access_token: "tok-2", expires_in: 3600 });
    clock = 3_600_000;
    expect(
      await getGoogleChatAdcAccessToken([CHAT_SCOPE], {
        guardedFetch: refreshed.fetch,
        now: () => clock,
      }),
    ).toBe("tok-2");
    expect(refreshed.calls).toHaveLength(1);
  });

  it("throws when the metadata response has no access_token", async () => {
    const { fetch } = fakeGuardedFetch({ expires_in: 3599 });
    await expect(
      getGoogleChatAdcAccessToken([CHAT_SCOPE], { guardedFetch: fetch, now: () => 0 }),
    ).rejects.toThrow(/access_token/);
  });

  it("throws when the metadata request fails", async () => {
    const { fetch } = fakeGuardedFetch("nope", { status: 500 });
    await expect(
      getGoogleChatAdcAccessToken([CHAT_SCOPE], { guardedFetch: fetch, now: () => 0 }),
    ).rejects.toThrow(/failed \(500\)/);
  });
});
