// Verifies ClawHub client authentication, URL, retry, timeout, and body bounds.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  fetchClawHubSkillInstallResolution,
  fetchClawHubSkillSecurityVerdicts,
  searchClawHubSkills,
} from "./clawhub-skills.js";

function createStalledBodyResponse(params: {
  headers: HeadersInit;
  firstChunk: Uint8Array;
  status?: number;
  statusText?: string;
}): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
} {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(params.firstChunk);
    },
    cancel(reason) {
      cancel(reason);
    },
  });
  return {
    response: new Response(body, {
      status: params.status ?? 200,
      statusText: params.statusText,
      headers: params.headers,
    }),
    cancel,
  };
}

function malformedUtf8(prefix: string, suffix: string): ArrayBuffer {
  const prefixBytes = new TextEncoder().encode(prefix);
  const suffixBytes = new TextEncoder().encode(suffix);
  const buffer = new ArrayBuffer(prefixBytes.byteLength + 1 + suffixBytes.byteLength);
  const bytes = new Uint8Array(buffer);
  bytes.set(prefixBytes);
  bytes[prefixBytes.byteLength] = 0xff;
  bytes.set(suffixBytes, prefixBytes.byteLength + 1);
  return buffer;
}

describe("clawhub client", () => {
  const originalEnv = captureEnv(["HOME", "XDG_CONFIG_HOME"]);

  async function expectSearchUsesAuthToken(expectedToken: string): Promise<void> {
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async (_input, init) => {
          expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${expectedToken}`);
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toStrictEqual([]);
  }

  afterEach(() => {
    delete process.env.OPENCLAW_CLAWHUB_URL;
    delete process.env.CLAWHUB_TOKEN;
    delete process.env.CLAWHUB_AUTH_TOKEN;
    delete process.env.CLAWHUB_CONFIG_PATH;
    delete process.env.CLAWDHUB_CONFIG_PATH;
    delete process.env.CLAWHUB_DISABLE_TELEMETRY;
    delete process.env.CLAWDHUB_DISABLE_TELEMETRY;
    originalEnv.restore();
  });

  it("loads ClawHub request auth from config.json", async () => {
    await withTempDir({ prefix: "openclaw-clawhub-config-" }, async (configRoot) => {
      const configPath = path.join(configRoot, "clawhub", "config.json");
      process.env.CLAWHUB_CONFIG_PATH = configPath;
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(
        configPath,
        JSON.stringify({ auth: { token: "fixture-config-token" } }),
        "utf8",
      );

      await expectSearchUsesAuthToken("fixture-config-token");
    });
  });

  it("loads ClawHub request auth from the legacy config path override", async () => {
    await withTempDir({ prefix: "openclaw-clawdhub-config-" }, async (configRoot) => {
      const configPath = path.join(configRoot, "config.json");
      process.env.CLAWDHUB_CONFIG_PATH = configPath;
      await fs.writeFile(configPath, JSON.stringify({ token: "fixture-legacy-token" }), "utf8");

      await expectSearchUsesAuthToken("fixture-legacy-token");
    });
  });

  it.runIf(process.platform === "darwin")(
    "loads ClawHub request auth from the macOS Application Support path",
    async () => {
      await withTempDir({ prefix: "openclaw-clawhub-home-" }, async (fakeHome) => {
        const configPath = path.join(
          fakeHome,
          "Library",
          "Application Support",
          "clawhub",
          "config.json",
        );
        const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
        try {
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          await fs.writeFile(configPath, JSON.stringify({ token: "fixture-macos-token" }), "utf8");

          await expectSearchUsesAuthToken("fixture-macos-token");
        } finally {
          homedirSpy.mockRestore();
        }
      });
    },
  );

  it.runIf(process.platform === "darwin")(
    "falls back to XDG_CONFIG_HOME for ClawHub request auth on macOS",
    async () => {
      await withTempDir({ prefix: "openclaw-clawhub-home-" }, async (fakeHome) => {
        await withTempDir({ prefix: "openclaw-clawhub-xdg-" }, async (xdgRoot) => {
          const configPath = path.join(xdgRoot, "clawhub", "config.json");
          const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
          setTestEnvValue("XDG_CONFIG_HOME", xdgRoot);
          try {
            await fs.mkdir(path.dirname(configPath), { recursive: true });
            await fs.writeFile(configPath, JSON.stringify({ token: "fixture-xdg-token" }), "utf8");

            await expectSearchUsesAuthToken("fixture-xdg-token");
          } finally {
            homedirSpy.mockRestore();
          }
        });
      });
    },
  );

  it("injects resolved auth token into ClawHub requests", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      expect(url).toContain("/api/v1/search");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-auth-token");
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    await expect(searchClawHubSkills({ query: "calendar", fetchImpl })).resolves.toStrictEqual([]);
  });

  it("preserves the configured ClawHub base URL path prefix", async () => {
    process.env.OPENCLAW_CLAWHUB_URL = "https://internal.example.com/clawhub";
    let requestedUrl = "";

    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async (input) => {
          requestedUrl = input instanceof Request ? input.url : String(input);
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toStrictEqual([]);

    const url = new URL(requestedUrl);
    expect(url.origin).toBe("https://internal.example.com");
    expect(url.pathname).toBe("/clawhub/api/v1/search");
    expect(url.searchParams.get("q")).toBe("calendar");
  });

  it("annotates 429 errors with the reset hint and a sign-in hint when unauthenticated", async () => {
    process.env.CLAWHUB_CONFIG_PATH = path.join(os.tmpdir(), "openclaw-no-clawhub-config");
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("Rate limit exceeded", {
            status: 429,
            headers: {
              "RateLimit-Limit": "30",
              "RateLimit-Remaining": "0",
              "RateLimit-Reset": "42",
            },
          }),
      }),
    ).rejects.toThrow(/Rate limit exceeded \(resets in 42s\) Sign in for higher rate limits\.$/);
  });

  it("degrades gracefully on 429 when the response carries no rate-limit headers", async () => {
    process.env.CLAWHUB_CONFIG_PATH = path.join(os.tmpdir(), "openclaw-no-clawhub-config");
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () => new Response("Rate limit exceeded", { status: 429 }),
      }),
    ).rejects.toThrow(/Rate limit exceeded Sign in for higher rate limits\.$/);
  });

  it.each(["0x10", "1e3", "-1", "-0", "+7", "0.5", "9007199254740993"])(
    "does not describe malformed RateLimit-Reset values as seconds: %s",
    async (reset) => {
      process.env.CLAWHUB_CONFIG_PATH = path.join(os.tmpdir(), "openclaw-no-clawhub-config");
      await expect(
        searchClawHubSkills({
          query: "calendar",
          fetchImpl: async () =>
            new Response("Rate limit exceeded", {
              status: 429,
              headers: { "RateLimit-Reset": reset },
            }),
        }),
      ).rejects.toThrow(/Rate limit exceeded Sign in for higher rate limits\.$/);
    },
  );

  it.each(["invalid", "+7", "-0"])(
    "uses a valid Retry-After hint when RateLimit-Reset is malformed: %s",
    async (reset) => {
      process.env.CLAWHUB_CONFIG_PATH = path.join(os.tmpdir(), "openclaw-no-clawhub-config");
      await expect(
        searchClawHubSkills({
          query: "calendar",
          fetchImpl: async () =>
            new Response("Rate limit exceeded", {
              status: 429,
              headers: {
                "RateLimit-Reset": reset,
                "Retry-After": "7",
              },
            }),
        }),
      ).rejects.toThrow(/Rate limit exceeded \(resets in 7s\) Sign in for higher rate limits\.$/);
    },
  );

  it("retries transient ClawHub reads and honors Retry-After", async () => {
    const cancel = vi.fn();
    let attempts = 0;
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) {
            return new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancel();
                },
              }),
              {
                status: 503,
                headers: { "Retry-After": "0" },
              },
            );
          }
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    ).resolves.toStrictEqual([]);

    expect(attempts).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("preserves the final ClawHub error body after transient retries are exhausted", async () => {
    let attempts = 0;
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () => {
          attempts += 1;
          return new Response("Rate limit temporarily unavailable", {
            status: 503,
            headers: { "Retry-After": "0" },
          });
        },
      }),
    ).rejects.toThrow("ClawHub /api/v1/search failed (503): Rate limit temporarily unavailable");

    expect(attempts).toBe(4);
  });

  it("does not retry non-idempotent ClawHub requests", async () => {
    let attempts = 0;
    await expect(
      fetchClawHubSkillSecurityVerdicts({
        items: [],
        skipAuth: true,
        fetchImpl: async () => {
          attempts += 1;
          return new Response("temporarily unavailable", { status: 503 });
        },
      }),
    ).rejects.toThrow("ClawHub /api/v1/skills/-/security-verdicts failed (503)");
    expect(attempts).toBe(1);
  });

  it("wraps malformed successful ClawHub JSON responses", async () => {
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("{not json", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/search returned malformed JSON");
  });

  it("rejects malformed UTF-8 in otherwise valid ClawHub JSON", async () => {
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response(malformedUtf8('{"results":[{"slug":"', '"}]}'), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("ClawHub /api/v1/search returned malformed JSON");
  });

  it("times out and cancels stalled successful ClawHub JSON bodies", async () => {
    const stalled = createStalledBodyResponse({
      firstChunk: new TextEncoder().encode('{"results":['),
      headers: { "content-type": "application/json" },
    });

    await expect(
      searchClawHubSkills({
        query: "calendar",
        timeoutMs: 5,
        fetchImpl: async () => stalled.response,
      }),
    ).rejects.toThrow(/ClawHub \/api\/v1\/search response stalled after 5ms/);
    expect(stalled.cancel).toHaveBeenCalledTimes(1);
    expect(stalled.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("times out and cancels stalled ClawHub error bodies", async () => {
    const stalledResponses: ReturnType<typeof createStalledBodyResponse>[] = [];

    await expect(
      searchClawHubSkills({
        query: "calendar",
        timeoutMs: 5,
        fetchImpl: async () => {
          const stalled = createStalledBodyResponse({
            firstChunk: new TextEncoder().encode("partial error"),
            headers: { "content-type": "text/plain", "retry-after": "0" },
            status: 500,
            statusText: "Server Error",
          });
          stalledResponses.push(stalled);
          return stalled.response;
        },
      }),
    ).rejects.toThrow("ClawHub /api/v1/search failed (500): Server Error");
    for (const stalled of stalledResponses) {
      expect(stalled.cancel).toHaveBeenCalledTimes(1);
    }
    const finalResponse = stalledResponses.at(-1);
    expect(finalResponse?.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("bounds oversized successful ClawHub JSON responses and cancels the stream", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(512 * 1024).fill("x".charCodeAt(0));
    const overshootChunks = 34; // 34 * 512 KiB = 17 MiB > 16 MiB cap
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= overshootChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancel();
      },
    });

    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(/ClawHub \/api\/v1\/search response exceeded 16777216 bytes/);
    // The reader is cancelled at the cap so the oversized stream releases its
    // socket/buffer instead of being drained into memory.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds oversized ClawHub error bodies to a short collapsed snippet", async () => {
    const oversized = "boom ".repeat(64 * 1024); // ~320 KiB error body
    let error: unknown;
    try {
      await searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response(oversized, { status: 500, headers: { "retry-after": "0" } }),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message.startsWith("ClawHub /api/v1/search failed (500): ")).toBe(true);
    expect(message.endsWith("…")).toBe(true);
    // prefix + 400-char snippet + "…" stays far below the raw ~320 KiB body.
    expect(message.length).toBeLessThanOrEqual(500);
  });

  it("bounds oversized ClawHub install-resolution JSON responses and cancels the stream", async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(512 * 1024).fill("x".charCodeAt(0));
    const overshootChunks = 34; // 34 * 512 KiB = 17 MiB > 16 MiB cap
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= overshootChunks) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancel();
      },
    });

    await expect(
      fetchClawHubSkillInstallResolution({
        slug: "weather",
        fetchImpl: async () =>
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow(
      /ClawHub \/api\/v1\/skills\/weather\/install response exceeded 16777216 bytes/,
    );
    // Same bounded reader covers the sibling install-resolution JSON path so a
    // hostile install response cannot exhaust memory either.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("annotates 429 errors with the reset hint but no sign-in hint when authenticated", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("Rate limit exceeded", {
            status: 429,
            headers: {
              "RateLimit-Limit": "180",
              "RateLimit-Remaining": "0",
              "RateLimit-Reset": "10",
            },
          }),
      }),
    ).rejects.toThrow(/Rate limit exceeded \(resets in 10s\)$/);
  });

  it("skips the reset suffix on 429 when Retry-After is an HTTP-date", async () => {
    process.env.CLAWHUB_TOKEN = "test-auth-token";
    await expect(
      searchClawHubSkills({
        query: "calendar",
        fetchImpl: async () =>
          new Response("Rate limit exceeded", {
            status: 429,
            headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
          }),
      }),
    ).rejects.toThrow(/Rate limit exceeded$/);
  });
});
