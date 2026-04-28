import { describe, expect, it, vi } from "vitest";
import {
  appendCdpPath,
  getHeadersWithAuth,
  normalizeCdpHttpBaseForJsonEndpoints,
} from "./cdp.helpers.js";
import { __test } from "./client-fetch.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { shouldRejectBrowserMutation } from "./csrf.js";
import { toBoolean } from "./routes/utils.js";
import type { BrowserServerState } from "./server-context.js";
import { listKnownProfileNames } from "./server-context.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

describe("toBoolean", () => {
  it("parses yes/no and 1/0", () => {
    expect(toBoolean("yes")).toBe(true);
    expect(toBoolean("1")).toBe(true);
    expect(toBoolean("no")).toBe(false);
    expect(toBoolean("0")).toBe(false);
  });

  it("returns undefined for on/off strings", () => {
    expect(toBoolean("on")).toBeUndefined();
    expect(toBoolean("off")).toBeUndefined();
  });

  it("passes through boolean values", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
  });
});

describe("browser target id resolution", () => {
  it("resolves exact ids", () => {
    const res = resolveTargetIdFromTabs("FULL", [{ targetId: "AAA" }, { targetId: "FULL" }]);
    expect(res).toEqual({ ok: true, targetId: "FULL" });
  });

  it("resolves exact tab ids and labels", () => {
    expect(
      resolveTargetIdFromTabs("t2", [
        { targetId: "AAA", tabId: "t1" },
        { targetId: "BBB", suggestedTargetId: "docs", tabId: "t2", label: "docs" },
      ]),
    ).toEqual({ ok: true, targetId: "BBB" });
    expect(
      resolveTargetIdFromTabs("docs", [
        { targetId: "AAA", tabId: "t1" },
        { targetId: "BBB", tabId: "t2", label: "docs" },
      ]),
    ).toEqual({ ok: true, targetId: "BBB" });
  });

  it("resolves unique prefixes (case-insensitive)", () => {
    const res = resolveTargetIdFromTabs("57a01309", [
      { targetId: "57A01309E14B5DEE0FB41F908515A2FC" },
    ]);
    expect(res).toEqual({
      ok: true,
      targetId: "57A01309E14B5DEE0FB41F908515A2FC",
    });
  });

  it("fails on ambiguous prefixes", () => {
    const res = resolveTargetIdFromTabs("57A0", [
      { targetId: "57A01309E14B5DEE0FB41F908515A2FC" },
      { targetId: "57A0BEEF000000000000000000000000" },
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("ambiguous");
      expect(res.matches?.length).toBe(2);
    }
  });

  it("fails when no tab matches", () => {
    const res = resolveTargetIdFromTabs("NOPE", [{ targetId: "AAA" }]);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("browser CSRF loopback mutation guard", () => {
  it("rejects mutating methods from non-loopback origin", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        origin: "https://evil.example",
      }),
    ).toBe(true);
  });

  it("allows mutating methods from loopback origin", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        origin: "http://127.0.0.1:18789",
      }),
    ).toBe(false);

    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        origin: "http://localhost:18789",
      }),
    ).toBe(false);
  });

  it("allows mutating methods without origin/referer (non-browser clients)", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
      }),
    ).toBe(false);
  });

  it("rejects mutating methods with origin=null", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        origin: "null",
      }),
    ).toBe(true);
  });

  it("rejects mutating methods from non-loopback referer", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        referer: "https://evil.example/attack",
      }),
    ).toBe(true);
  });

  it("rejects cross-site mutations via Sec-Fetch-Site when present", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "POST",
        secFetchSite: "cross-site",
      }),
    ).toBe(true);
  });

  it("does not reject non-mutating methods", () => {
    expect(
      shouldRejectBrowserMutation({
        method: "GET",
        origin: "https://evil.example",
      }),
    ).toBe(false);

    expect(
      shouldRejectBrowserMutation({
        method: "OPTIONS",
        origin: "https://evil.example",
      }),
    ).toBe(false);
  });
});

describe("cdp.helpers", () => {
  it("preserves query params when appending CDP paths", () => {
    const url = appendCdpPath("https://example.com?token=abc", "/json/version");
    expect(url).toBe("https://example.com/json/version?token=abc");
  });

  it("appends paths under a base prefix", () => {
    const url = appendCdpPath("https://example.com/chrome/?token=abc", "json/list");
    expect(url).toBe("https://example.com/chrome/json/list?token=abc");
  });

  it("normalizes direct WebSocket CDP URLs to an HTTP base for /json endpoints", () => {
    const url = normalizeCdpHttpBaseForJsonEndpoints(
      "wss://connect.example.com/devtools/browser/ABC?token=abc",
    );
    expect(url).toBe("https://connect.example.com/?token=abc");
  });

  it("preserves auth and query params when normalizing secure loopback WebSocket CDP URLs", () => {
    const url = normalizeCdpHttpBaseForJsonEndpoints(
      "wss://user:pass@127.0.0.1:9222/devtools/browser/ABC?token=abc",
    );
    expect(url).toBe("https://user:pass@127.0.0.1:9222/?token=abc");
  });

  it("strips a trailing /cdp suffix when normalizing HTTP bases", () => {
    const url = normalizeCdpHttpBaseForJsonEndpoints("ws://127.0.0.1:9222/cdp?token=abc");
    expect(url).toBe("http://127.0.0.1:9222/?token=abc");
  });

  it("preserves base prefixes when stripping a trailing /cdp suffix", () => {
    const url = normalizeCdpHttpBaseForJsonEndpoints("ws://127.0.0.1:9222/browser/cdp?token=abc");
    expect(url).toBe("http://127.0.0.1:9222/browser?token=abc");
  });

  it("adds basic auth headers when credentials are present", () => {
    const headers = getHeadersWithAuth("https://user:pass@example.com");
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });

  it("keeps preexisting authorization headers", () => {
    const headers = getHeadersWithAuth("https://user:pass@example.com", {
      Authorization: "Bearer token",
    });
    expect(headers.Authorization).toBe("Bearer token");
  });

  it("does not add custom headers when none are required", () => {
    expect(getHeadersWithAuth("http://127.0.0.1:19444/json/version")).toEqual({});
  });
});

describe("fetchBrowserJson loopback auth (bridge auth registry)", () => {
  it("falls back to per-port bridge auth when config auth is not available", async () => {
    const port = 18765;
    const getBridgeAuthForPort = vi.fn((candidate: number) =>
      candidate === port ? { token: "registry-token" } : undefined,
    );
    const init = __test.withLoopbackBrowserAuth(`http://127.0.0.1:${port}/`, undefined, {
      getRuntimeConfig: () => ({}),
      resolveBrowserControlAuth: () => ({}),
      getBridgeAuthForPort,
    });
    const headers = new Headers(init.headers ?? {});
    expect(headers.get("authorization")).toBe("Bearer registry-token");
    expect(getBridgeAuthForPort).toHaveBeenCalledWith(port);
  });
});

describe("browser server-context listKnownProfileNames", () => {
  it("includes configured and runtime-only profile names", () => {
    const resolved = resolveBrowserConfig({
      defaultProfile: "openclaw",
      profiles: {
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    });
    const openclaw = resolveProfile(resolved, "openclaw");
    if (!openclaw) {
      throw new Error("expected openclaw profile");
    }

    const state: BrowserServerState = {
      server: null as unknown as BrowserServerState["server"],
      port: 18791,
      resolved,
      profiles: new Map([
        [
          "stale-removed",
          {
            profile: { ...openclaw, name: "stale-removed" },
            running: null,
          },
        ],
      ]),
    };

    expect(listKnownProfileNames(state).toSorted()).toEqual(["openclaw", "stale-removed", "user"]);
  });
});
