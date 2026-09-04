import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  PROXY_FIXTURE_HOST,
  PROXY_FIXTURE_PAYLOAD,
  withProxyFixture,
} from "openclaw/plugin-sdk/test-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import type { TelegramContext } from "./bot/types.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { resolveTelegramTransport } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

beforeEach(() => {
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "OPENCLAW_PROXY_URL",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
  ]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

it.each(["explicit", "environment", "ALL_PROXY", "standard-over-managed"])(
  "sends Bot API transport requests through a plain %s SOCKS proxy",
  async (mode) => {
    await withProxyFixture(async ({ socksProxy, httpProxy, connections }) => {
      if (mode === "environment" || mode === "standard-over-managed") {
        vi.stubEnv("HTTP_PROXY", socksProxy);
        vi.stubEnv("HTTPS_PROXY", socksProxy);
      }
      if (mode === "standard-over-managed") {
        vi.stubEnv("OPENCLAW_PROXY_URL", httpProxy);
      }
      if (mode === "ALL_PROXY") {
        vi.stubEnv("ALL_PROXY", socksProxy);
      }
      const transport = resolveTelegramTransport(
        mode === "explicit" ? makeProxyFetch(socksProxy) : undefined,
      );
      try {
        const response = await transport.fetch(`http://${PROXY_FIXTURE_HOST}/media`, {
          signal: AbortSignal.timeout(5_000),
        });

        expect(await response.text()).toBe(PROXY_FIXTURE_PAYLOAD);
        expect(connections).toEqual([`socks:${PROXY_FIXTURE_HOST}`]);
        expect(transport.dispatcherAttempts?.[0]?.dispatcherPolicy?.mode).toBe(
          mode === "explicit" ? "explicit-proxy" : "env-proxy",
        );
      } finally {
        await transport.close();
      }
    });
  },
);

it("preserves direct fallback when environment proxy initialization rejects a malformed URL", async () => {
  vi.stubEnv("HTTPS_PROXY", "not a proxy URL");
  await withProxyFixture(async ({ httpOrigin, connections }) => {
    const transport = resolveTelegramTransport();
    try {
      const response = await transport.fetch(`${httpOrigin}/media`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(await response.text()).toBe(PROXY_FIXTURE_PAYLOAD);
      expect(connections).toEqual([]);
    } finally {
      await transport.close();
    }
  });
});

it("downloads distinct concurrent attachments, cancels an in-flight body, and recovers through SOCKS", async () => {
  await withOpenClawTestState({ label: "telegram-socks-media" }, async () => {
    await withProxyFixture(async ({ socksProxy, waitForSocketsClosed }) => {
      const token = "12345:fixture-token";
      const apiRoot = `http://${PROXY_FIXTURE_HOST}`;
      const transport = resolveTelegramTransport(makeProxyFetch(socksProxy));
      const bodyReady = createDeferred<void>();
      const sourceFetch = transport.sourceFetch;
      transport.sourceFetch = async (input, init) => {
        const response = await sourceFetch(input, init);
        if (typeof input === "string" && input.endsWith("/stall")) {
          bodyReady.resolve();
        }
        return response;
      };
      const clientFetch = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(transport.fetch),
        transport,
      });
      assert(clientFetch);
      const api = new Api(token, { apiRoot, fetch: asTelegramClientFetch(clientFetch) });
      const contextFor = (fileId: string): TelegramContext => ({
        message: {
          message_id: 1,
          date: 0,
          chat: { id: 1, type: "private", first_name: "Fixture" },
          document: {
            file_id: fileId,
            file_unique_id: fileId,
            file_name: `${fileId}.txt`,
          },
        },
        getFile: (signal) => api.getFile(fileId, signal),
      });
      const download = (fileId: string, abortSignal?: AbortSignal) =>
        resolveMedia({
          ctx: contextFor(fileId),
          token,
          transport,
          apiRoot,
          maxBytes: 1_024,
          abortSignal,
        });
      try {
        await Promise.all(
          Array.from({ length: 16 }, async (_, index) => {
            const fileId = `attachment-${index}`;
            const media = await download(fileId);
            assert(media);
            expect(media.fileName).toBe(`${fileId}.txt`);
            expect(await readFile(media.path, "utf8")).toBe(fileId);
          }),
        );
        const controller = new AbortController();
        const rejected = expect(
          download("stall", AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)])),
        ).rejects.toThrow(/aborted|cancelled/i);
        await Promise.race([
          bodyReady.promise,
          rejected.then(() => {
            throw new Error("download ended before response headers");
          }),
        ]);
        controller.abort(new Error("fixture media cancelled"));
        await rejected;
        const recovered = await download("recovered");
        assert(recovered);
        expect(await readFile(recovered.path, "utf8")).toBe("recovered");
      } finally {
        await transport.close();
      }
      await waitForSocketsClosed();
    });
  });
});
