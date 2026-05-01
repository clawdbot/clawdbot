import type { MockInstance } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";
import * as ssrf from "../infra/net/ssrf.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";

function resolveRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export function installPinnedHostnameTestHooks(): void {
  const resolvePinnedHostname = ssrf.resolvePinnedHostname;
  const resolvePinnedHostnameWithPolicy = ssrf.resolvePinnedHostnameWithPolicy;

  const lookupMock = vi.fn();
  let resolvePinnedHostnameSpy: MockInstance | null = null;
  let resolvePinnedHostnameWithPolicySpy: MockInstance | null = null;

  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    resolvePinnedHostnameSpy = vi
      .spyOn(ssrf, "resolvePinnedHostname")
      .mockImplementation((hostname) => resolvePinnedHostname(hostname, lookupMock));
    resolvePinnedHostnameWithPolicySpy = vi
      .spyOn(ssrf, "resolvePinnedHostnameWithPolicy")
      .mockImplementation((hostname, params) =>
        resolvePinnedHostnameWithPolicy(hostname, { ...params, lookupFn: lookupMock }),
      );
  });

  afterEach(() => {
    lookupMock.mockReset();
    resolvePinnedHostnameSpy?.mockRestore();
    resolvePinnedHostnameWithPolicySpy?.mockRestore();
    resolvePinnedHostnameSpy = null;
    resolvePinnedHostnameWithPolicySpy = null;
  });
}

export function createAuthCaptureJsonFetch(responseBody: unknown) {
  let seenAuth: string | null = null;
  const fetchFn = withFetchPreconnect(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seenAuth = headers.get("authorization");
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    fetchFn,
    getAuthHeader: () => seenAuth,
  };
}

export function createRequestCaptureJsonFetch(responseBody: unknown) {
  let seenUrl: string | null = null;
  let seenInit: RequestInit | undefined;
  const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = resolveRequestUrl(input);
    seenInit = init;
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    fetchFn,
    getRequest: () => ({ url: seenUrl, init: seenInit }),
  };
}
