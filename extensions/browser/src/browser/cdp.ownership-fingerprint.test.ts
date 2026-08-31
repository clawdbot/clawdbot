import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import { resolveCdpTabOwnership } from "./cdp.helpers.js";

function endpointWithFixtureAuth(protocol: "https:" | "wss:", path: string, value: string): string {
  const endpoint = new URL(`${protocol}//browser.example${path}`);
  endpoint.username = "fixture-user";
  endpoint.password = value;
  endpoint.searchParams.set("auth", value);
  return endpoint.toString();
}

function mockVersion(browserWebSocketUrl: string): void {
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(JSON.stringify({ webSocketDebuggerUrl: browserWebSocketUrl })),
    release: vi.fn(async () => {}),
  });
}

describe("CDP ownership fingerprints", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  it("ignores rotated endpoint credentials", async () => {
    const firstFixture = "fixture-value-a-with-more-than-eighteen-characters";
    const secondFixture = "fixture-value-b-with-more-than-eighteen-characters";
    mockVersion(endpointWithFixtureAuth("wss:", "/devtools/browser/BROWSER-1", firstFixture));
    const first = await resolveCdpTabOwnership({
      profileName: "remote",
      cdpUrl: endpointWithFixtureAuth("https:", "", firstFixture),
      nativeTargetId: "TARGET-1",
    });
    mockVersion(endpointWithFixtureAuth("wss:", "/devtools/browser/BROWSER-1", secondFixture));
    const rotated = await resolveCdpTabOwnership({
      profileName: "remote",
      cdpUrl: endpointWithFixtureAuth("https:", "", secondFixture),
      nativeTargetId: "TARGET-1",
    });

    expect(first).toEqual(rotated);
  });

  it("refuses provider paths that may embed credentials", async () => {
    mockVersion("wss://browser.example/session/fixture-value/devtools/browser/BROWSER-1");
    await expect(
      resolveCdpTabOwnership({
        profileName: "remote",
        cdpUrl: "https://browser.example",
        nativeTargetId: "TARGET-1",
      }),
    ).resolves.toEqual({ status: "non-durable", reason: "browser-identity-unavailable" });

    const fixturePath = "fixture-path-segment-".repeat(4);
    mockVersion("wss://browser.example/devtools/browser/BROWSER-1");
    await expect(
      resolveCdpTabOwnership({
        profileName: "remote",
        cdpUrl: `https://browser.example/session/${fixturePath}`,
        nativeTargetId: "TARGET-1",
      }),
    ).resolves.toEqual({ status: "non-durable", reason: "browser-identity-unavailable" });
  });
});
