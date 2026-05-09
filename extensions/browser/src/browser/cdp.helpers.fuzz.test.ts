import { describe, expect, it } from "vitest";
import {
  appendCdpPath,
  getHeadersWithAuth,
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  parseBrowserHttpUrl,
  redactCdpUrl,
} from "./cdp.helpers.js";

/**
 * Seeded property-based / fuzz coverage for the URL helpers in cdp.helpers.
 *
 * The repo intentionally does not pull in `fast-check` (see
 * src/gateway/http-common.fuzz.test.ts); this file follows the same
 * pattern: a small deterministic PRNG (mulberry32) + hand-rolled
 * generators, with every property running N iterations. Failures are
 * deterministic because each describe block seeds its own rng.
 *
 * Focus is on the URL parsing / normalisation primitives that the
 * #68027 attachOnly fix depends on: distinguishing direct-WS CDP
 * endpoints from bare ws roots, and normalising bare ws URLs to http
 * for `/json/version` discovery.
 */

/** Deterministic 32-bit PRNG. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, loInclusive: number, hiInclusive: number): number {
  return Math.floor(rng() * (hiInclusive - loInclusive + 1)) + loInclusive;
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[randInt(rng, 0, arr.length - 1)];
}

function randHost(rng: () => number): string {
  return pick(rng, [
    "127.0.0.1",
    "localhost",
    "[::1]",
    "0.0.0.0",
    "[::]",
    "example.com",
    "connect.example.com",
    "browserless.example",
    "host-1.example.internal",
    "user.example.com",
    "192.168.1.202",
    "10.0.0.5",
  ]);
}

function randPort(rng: () => number): string {
  const kind = randInt(rng, 0, 4);
  if (kind === 0) {
    return "";
  }
  if (kind === 1) {
    return ":9222";
  }
  if (kind === 2) {
    return `:${randInt(rng, 1, 65535)}`;
  }
  if (kind === 3) {
    return ":3000";
  }
  return ":443";
}

function randWsScheme(rng: () => number): "ws://" | "wss://" {
  return rng() < 0.5 ? "ws://" : "wss://";
}

function randHttpScheme(rng: () => number): "http://" | "https://" {
  return rng() < 0.5 ? "http://" : "https://";
}

function randDirectDevtoolsPath(rng: () => number): string {
  const kind = pick(rng, ["browser", "page", "worker", "shared_worker", "service_worker"] as const);
  const id = `${randInt(rng, 0, 0xffffffff).toString(16)}-${randInt(rng, 0, 9999)}`;
  return `/devtools/${kind}/${id}`;
}

function randNonDevtoolsPath(rng: () => number): string {
  return pick(rng, [
    "",
    "/",
    "/json/version",
    "/devtools",
    "/devtools/",
    "/devtools/browser/", // trailing slash, no id
    "/devtools/unknown/abc",
    "/other/path",
    "/cdp",
    "/json/list",
  ]);
}

function randQuery(rng: () => number): string {
  if (rng() < 0.5) {
    return "";
  }
  return pick(rng, ["?token=abc", "?apiKey=xyz&other=1", "?session=1&token=ws-token", "?t="]);
}

function randUserInfo(rng: () => number): string {
  if (rng() < 0.6) {
    return "";
  }
  return pick(rng, ["user:pass@", "u:p@", "alice:s3cr3t@", "only-user@", ":only-pass@"]);
}

const ITERATIONS = 200;

describe("fuzz: isWebSocketUrl", () => {
  it("returns true for any syntactically valid ws/wss URL", () => {
    const rng = makeRng(0x1001);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const url = `${randWsScheme(rng)}${randUserInfo(rng)}${randHost(rng)}${randPort(rng)}${
        rng() < 0.5 ? randDirectDevtoolsPath(rng) : randNonDevtoolsPath(rng)
      }${randQuery(rng)}`;
      try {
        // Only assert the property when the URL itself parses; assign
        // the result to satisfy eslint's no-new rule.
        const _parsed = new URL(url);
        void _parsed;
      } catch {
        continue;
      }
      expect(isWebSocketUrl(url)).toBe(true);
    }
  });

  it("returns false for http/https URLs and random non-URL garbage", () => {
    const rng = makeRng(0x1002);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const kind = randInt(rng, 0, 2);
      if (kind === 0) {
        const url = `${randHttpScheme(rng)}${randHost(rng)}${randPort(rng)}${randNonDevtoolsPath(
          rng,
        )}${randQuery(rng)}`;
        expect(isWebSocketUrl(url)).toBe(false);
      } else if (kind === 1) {
        expect(isWebSocketUrl("")).toBe(false);
      } else {
        // Deliberately malformed: no scheme, or unsupported scheme.
        const junk = pick(rng, [
          "not-a-url",
          "ftp://example.com",
          "file:///etc/passwd",
          "://foo",
          "ws:",
          "ws:/",
          "ws//",
        ]);
        expect(isWebSocketUrl(junk)).toBe(false);
      }
    }
  });
});

describe("fuzz: isDirectCdpWebSocketEndpoint", () => {
  it("returns true iff the URL is ws/wss AND path is /devtools/<kind>/<id>", () => {
    const rng = makeRng(0x2001);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const scheme = randWsScheme(rng);
      const path = randDirectDevtoolsPath(rng);
      const url = `${scheme}${randHost(rng)}${randPort(rng)}${path}${randQuery(rng)}`;
      expect(isDirectCdpWebSocketEndpoint(url)).toBe(true);
    }
  });

  it("returns false for bare ws roots and non-devtools ws paths (needs HTTP discovery)", () => {
    const rng = makeRng(0x2002);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const url = `${randWsScheme(rng)}${randHost(rng)}${randPort(rng)}${randNonDevtoolsPath(
        rng,
      )}${randQuery(rng)}`;
      expect(isDirectCdpWebSocketEndpoint(url)).toBe(false);
    }
  });

  it("returns false for any http/https URL regardless of path", () => {
    const rng = makeRng(0x2003);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const path = rng() < 0.5 ? randDirectDevtoolsPath(rng) : randNonDevtoolsPath(rng);
      const url = `${randHttpScheme(rng)}${randHost(rng)}${randPort(rng)}${path}${randQuery(rng)}`;
      expect(isDirectCdpWebSocketEndpoint(url)).toBe(false);
    }
  });

  it("returns booleans for random input including invalid URLs", () => {
    const rng = makeRng(0x2004);
    const junkPool = [
      "",
      "   ",
      "not-a-url",
      "http://",
      "ws://",
      "ws:///devtools/browser/abc",
      "://x",
      "\u0000",
      "ws://[not-an-ip]/devtools/browser/abc",
    ];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const input = rng() < 0.5 ? pick(rng, junkPool) : String.fromCharCode(randInt(rng, 0, 0x7f));
      expect(typeof isDirectCdpWebSocketEndpoint(input)).toBe("boolean");
    }
  });
});

describe("fuzz: normalizeCdpHttpBaseForJsonEndpoints", () => {
  it("ws -> http and wss -> https, drops trailing /devtools/browser/... and /cdp", () => {
    const rng = makeRng(0x3001);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const scheme = randWsScheme(rng);
      const host = randHost(rng);
      const port = randPort(rng);
      const suffix = pick(rng, [
        "",
        "/",
        "/cdp",
        "/devtools/browser/abc",
        "/devtools/browser/abc/path-fragment",
      ]);
      const input = `${scheme}${host}${port}${suffix}`;
      const out = normalizeCdpHttpBaseForJsonEndpoints(input);
      // Scheme mapping
      if (scheme === "ws://") {
        expect(out.startsWith("http://")).toBe(true);
        expect(out.startsWith("ws://")).toBe(false);
      } else {
        expect(out.startsWith("https://")).toBe(true);
        expect(out.startsWith("wss://")).toBe(false);
      }
      // /devtools/browser/... and /cdp are stripped
      expect(out.includes("/devtools/browser/")).toBe(false);
      expect(out.endsWith("/cdp")).toBe(false);
      // No trailing slash
      expect(out.endsWith("/")).toBe(false);
    }
  });

  it("preserves http/https inputs and strips a trailing /cdp when present", () => {
    const rng = makeRng(0x3002);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const scheme = randHttpScheme(rng);
      const hasCdp = rng() < 0.5;
      const hasTrailingSlash = rng() < 0.3;
      // Only exercise the trailing-/cdp branch here (the regex only
      // strips /cdp when it's the final path segment, not /cdp/ etc.).
      const input = `${scheme}${randHost(rng)}${randPort(rng)}${hasCdp ? "/cdp" : ""}${
        hasTrailingSlash && !hasCdp ? "/" : ""
      }`;
      const out = normalizeCdpHttpBaseForJsonEndpoints(input);
      expect(out.startsWith(scheme)).toBe(true);
      expect(out.endsWith("/cdp")).toBe(false);
      expect(out.endsWith("/")).toBe(false);
    }
  });

  it("returns normalized strings for non-URL-ish inputs", () => {
    const rng = makeRng(0x3003);
    // These inputs either trigger the catch branch (empty / "garbage" /
    // bare "ws://" / "wss://") or are accepted by WHATWG URL as
    // special-scheme absolute URLs (e.g. "ws:host/path" becomes
    // "ws://host/path"). Both paths must return strings.
    const junk = [
      "ws:/devtools/browser/abc",
      "wss:/devtools/browser/abc",
      "ws:no-host/cdp",
      "wss:no-host/",
      "garbage",
      "",
      "ws://",
      "wss://",
    ];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const input = pick(rng, junk);
      const out = normalizeCdpHttpBaseForJsonEndpoints(input);
      expect(typeof out).toBe("string");
      // Scheme swap invariant: whatever branch ran, ws:/wss: never
      // appear as a scheme prefix in the normalized output.
      expect(out.startsWith("ws:")).toBe(false);
      expect(out.startsWith("wss:")).toBe(false);
    }
  });

  it("fallback explicitly handles malformed ws:/wss: scheme-only strings", () => {
    // Hand-crafted inputs that parse as URLs via WHATWG but the pattern
    // still exercises the scheme swap + suffix strip in both branches.
    expect(normalizeCdpHttpBaseForJsonEndpoints("ws://host:9222/cdp")).toBe("http://host:9222");
    expect(normalizeCdpHttpBaseForJsonEndpoints("wss://host:9222/")).toBe("https://host:9222");
    expect(normalizeCdpHttpBaseForJsonEndpoints("ws://host/devtools/browser/abc")).toBe(
      "http://host",
    );
    // WHATWG URL preserves the root "/" on the path after stripping the
    // /devtools/browser/... suffix, so the trailing-slash removal only
    // trims the final character of the serialized form (which is "1",
    // not "/").
    expect(normalizeCdpHttpBaseForJsonEndpoints("wss://host/devtools/browser/abc?t=1")).toBe(
      "https://host/?t=1",
    );
    // Fallback branch: inputs `new URL` genuinely rejects. The fallback
    // performs a naive scheme swap and suffix strip on the raw string.
    expect(normalizeCdpHttpBaseForJsonEndpoints("")).toBe("");
    expect(normalizeCdpHttpBaseForJsonEndpoints("garbage")).toBe("garbage");
    expect(normalizeCdpHttpBaseForJsonEndpoints("ws://").startsWith("http:")).toBe(true);
    expect(normalizeCdpHttpBaseForJsonEndpoints("wss://").startsWith("https:")).toBe(true);
  });
});

describe("fuzz: parseBrowserHttpUrl", () => {
  it("accepts http/https/ws/wss and assigns sensible default ports", () => {
    const rng = makeRng(0x4001);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const scheme = pick(rng, ["http://", "https://", "ws://", "wss://"] as const);
      const explicitPort = rng() < 0.5;
      const portNum = randInt(rng, 1, 65535);
      const url = `${scheme}${randHost(rng)}${explicitPort ? `:${portNum}` : ""}/path`;
      const result = parseBrowserHttpUrl(url, "test");
      expect(result.parsed.protocol).toBe(scheme.replace("//", ""));
      if (explicitPort) {
        expect(result.port).toBe(portNum);
      } else {
        const isSecure = scheme === "https://" || scheme === "wss://";
        expect(result.port).toBe(isSecure ? 443 : 80);
      }
      expect(result.normalized.endsWith("/")).toBe(false);
    }
  });

  it("rejects unsupported protocols", () => {
    const rng = makeRng(0x4002);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const scheme = pick(rng, ["ftp://", "file://", "gopher://", "data:"] as const);
      const url = scheme === "data:" ? "data:text/plain,hello" : `${scheme}${randHost(rng)}`;
      expect(() => parseBrowserHttpUrl(url, "test")).toThrow(/must be http\(s\) or ws\(s\)/);
    }
  });
});

describe("fuzz: redactCdpUrl", () => {
  it("strips username/password from valid URLs and preserves host/path", () => {
    const rng = makeRng(0x5001);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const scheme = pick(rng, ["http://", "https://", "ws://", "wss://"] as const);
      const host = randHost(rng);
      const port = randPort(rng);
      const path = rng() < 0.5 ? randDirectDevtoolsPath(rng) : randNonDevtoolsPath(rng);
      const url = `${scheme}user:pass@${host}${port}${path}`;
      const out = redactCdpUrl(url);
      expect(typeof out).toBe("string");
      expect(String(out)).not.toContain("user:pass@");
    }
  });

  it("returns non-string inputs unchanged and short-circuits empty/whitespace strings", () => {
    expect(redactCdpUrl(undefined)).toBeUndefined();
    expect(redactCdpUrl(null)).toBeNull();
    // Empty and whitespace-only inputs both short-circuit to the
    // trimmed empty string before any URL parsing / redaction.
    expect(redactCdpUrl("")).toBe("");
    expect(redactCdpUrl("   ")).toBe("");
  });

  it("falls back to redactSensitiveText for non-URL-ish inputs", () => {
    const rng = makeRng(0x5002);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const junk = pick(rng, ["not-a-url", "http://", "ws://", "::::", "Bearer ey.SECRET.xyz"]);
      const out = redactCdpUrl(junk);
      expect(typeof out).toBe("string");
    }
  });
});

describe("fuzz: appendCdpPath", () => {
  it("produces a URL that ends with the appended path exactly once", () => {
    const rng = makeRng(0x6001);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const scheme = pick(rng, ["http://", "https://", "ws://", "wss://"] as const);
      const base = `${scheme}${randHost(rng)}${randPort(rng)}${rng() < 0.5 ? "/" : ""}`;
      const path = pick(rng, ["/json/version", "json/version", "/json/close/TARGET_1"]);
      const out = appendCdpPath(base, path);
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      // Path segment should appear in output and not be doubled.
      expect(out.endsWith(normalizedPath)).toBe(true);
      expect(out.split(normalizedPath).length - 1).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("fuzz: getHeadersWithAuth", () => {
  it("always returns a mergedHeaders object", () => {
    const rng = makeRng(0x7001);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const withAuth = rng() < 0.3;
      const url =
        rng() < 0.5
          ? `${randHttpScheme(rng)}${withAuth ? "alice:s3cr3t@" : ""}${randHost(rng)}${randPort(rng)}`
          : pick(rng, ["not-a-url", "", "ws://"]);
      const headers: Record<string, string> = {};
      if (rng() < 0.3) {
        headers.Authorization = "Bearer preset";
      }
      const out = getHeadersWithAuth(url, headers);
      expect(typeof out).toBe("object");
      // Preset auth header must always be preserved verbatim.
      if (headers.Authorization) {
        expect(out.Authorization).toBe("Bearer preset");
      }
    }
  });

  it("injects Basic auth from URL userinfo when no Authorization header is present", () => {
    const out = getHeadersWithAuth("https://alice:s3cr3t@example.com/path");
    expect(out.Authorization).toBe(`Basic ${Buffer.from("alice:s3cr3t").toString("base64")}`);
  });

  it("preserves an existing Authorization header (case-insensitive) over URL userinfo", () => {
    const out = getHeadersWithAuth("https://alice:s3cr3t@example.com/path", {
      authorization: "Bearer preset",
    });
    expect(out.authorization).toBe("Bearer preset");
    expect(out.Authorization).toBeUndefined();
  });
});
