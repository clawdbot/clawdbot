// Discord tests cover probe.intents plugin behavior.
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDiscordApplicationId,
  fetchDiscordApplicationSummary,
  probeDiscord,
  resolveDiscordPrivilegedIntentsFromFlags,
} from "./probe.js";
import { jsonResponse } from "./test-http-helpers.js";

const DISCORD_PROBE_JSON_CAP_BYTES = 16 * 1024 * 1024;

function oversizedDiscordProbeJsonResponse(onCancel: () => void): Response {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DISCORD_PROBE_JSON_CAP_BYTES + 1));
      },
      cancel() {
        onCancel();
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
  Object.defineProperty(response, "json", {
    value: async () => {
      throw new Error("unbounded json reader was used");
    },
  });
  return response;
}

function trackedTricklingDiscordProbeJsonResponse(
  signal: AbortSignal | null | undefined,
  onTerminate: () => void,
): Response {
  let interval: ReturnType<typeof setInterval> | undefined;
  let terminated = false;
  const terminate = () => {
    if (terminated) {
      return;
    }
    terminated = true;
    if (interval) {
      clearInterval(interval);
    }
    onTerminate();
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          terminate();
          controller.error(signal?.reason ?? new Error("request aborted"));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        controller.enqueue(new TextEncoder().encode('{"id":"bot-1"'));
        interval = setInterval(() => controller.enqueue(new Uint8Array([0x20])), 10);
        signal?.addEventListener("abort", abort, { once: true });
      },
      cancel() {
        terminate();
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

function trackedStalledDiscordJsonResponse(
  signal: AbortSignal | null | undefined,
  onTerminate: () => void,
): Response {
  let terminated = false;
  const terminate = () => {
    if (terminated) {
      return;
    }
    terminated = true;
    onTerminate();
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          terminate();
          controller.error(signal?.reason ?? new Error("request aborted"));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      },
      cancel() {
        terminate();
      },
    }),
    { headers: { "content-type": "application/json" }, status: 200 },
  );
}

describe("resolveDiscordPrivilegedIntentsFromFlags", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports disabled when no bits set", () => {
    expect(resolveDiscordPrivilegedIntentsFromFlags(0)).toEqual({
      presence: "disabled",
      guildMembers: "disabled",
      messageContent: "disabled",
    });
  });

  it("reports enabled when full intent bits set", () => {
    const flags = (1 << 12) | (1 << 14) | (1 << 18);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "enabled",
      guildMembers: "enabled",
      messageContent: "enabled",
    });
  });

  it("reports limited when limited intent bits set", () => {
    const flags = (1 << 13) | (1 << 15) | (1 << 19);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "limited",
      guildMembers: "limited",
      messageContent: "limited",
    });
  });

  it("prefers enabled over limited when both set", () => {
    const flags = (1 << 12) | (1 << 13) | (1 << 14) | (1 << 15) | (1 << 18) | (1 << 19);
    expect(resolveDiscordPrivilegedIntentsFromFlags(flags)).toEqual({
      presence: "enabled",
      guildMembers: "enabled",
      messageContent: "enabled",
    });
  });

  it("retries Cloudflare HTML rate limits during application id lookup", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("<html><title>Error 1015</title></html>", {
          status: 429,
          headers: { "content-type": "text/html", "retry-after": "0" },
        });
      }
      return jsonResponse({ id: "app-1" });
    });

    vi.useFakeTimers();
    const lookup = fetchDiscordApplicationId("unparseable.token", 1_000, fetcher);
    await vi.runAllTimersAsync();

    await expect(lookup).resolves.toBe("app-1");
    expect(calls).toBe(2);
  });

  it("does not retry Cloudflare HTML rate limits during application summary probes", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      return new Response("<html><title>Error 1015</title></html>", {
        status: 429,
        headers: { "content-type": "text/html" },
      });
    });

    await expect(
      fetchDiscordApplicationSummary("unparseable.token", 1_000, fetcher),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it("cancels failed getMe probe response bodies", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetcher = withFetchPreconnect(
      async () => ({ ok: false, status: 401, body: { cancel } }) as unknown as Response,
    );

    await expect(probeDiscord("MTIz.abc.def", 1_000, { fetcher })).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: "getMe failed (401)",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid UTF-8 in getMe probe JSON responses", async () => {
    const prefix = new TextEncoder().encode('{"id":"bot-1","username":"bad');
    const suffix = new TextEncoder().encode('"}');
    const body = new Uint8Array(prefix.length + 1 + suffix.length);
    body.set(prefix);
    body[prefix.length] = 0xff;
    body.set(suffix, prefix.length + 1);
    const fetcher = withFetchPreconnect(
      async () =>
        new Response(body, {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );

    await expect(probeDiscord("MTIz.abc.def", 1_000, { fetcher })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("discord.probe.getMe: malformed JSON response"),
    });
  });

  it("bounds oversized getMe probe JSON responses and cancels the stream", async () => {
    let cancelCount = 0;
    const fetcher = withFetchPreconnect(async () =>
      oversizedDiscordProbeJsonResponse(() => {
        cancelCount += 1;
      }),
    );

    await expect(probeDiscord("MTIz.abc.def", 1_000, { fetcher })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("discord.probe.getMe: JSON response exceeds 16777216 bytes"),
    });
    expect(cancelCount).toBe(1);
  });

  it("times out and cancels stalled getMe probe JSON response bodies", async () => {
    vi.useFakeTimers();
    try {
      let terminationCount = 0;
      const fetcher = withFetchPreconnect(async (_input, init) =>
        trackedStalledDiscordJsonResponse(init?.signal, () => {
          terminationCount += 1;
        }),
      );

      const probe = probeDiscord("MTIz.abc.def", 50, { fetcher });
      const assertion = expect(probe).resolves.toMatchObject({
        ok: false,
        error: "discord.probe.getMe: JSON response timed out after 50ms",
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(terminationCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses one total deadline across getMe headers and a trickling JSON body", async () => {
    vi.useFakeTimers();
    try {
      let terminationCount = 0;
      const fetcher = withFetchPreconnect(async (_input, init) => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 30);
        });
        return trackedTricklingDiscordProbeJsonResponse(init?.signal, () => {
          terminationCount += 1;
        });
      });

      const probe = probeDiscord("MTIz.abc.def", 50, { fetcher });
      const assertion = expect(probe).resolves.toMatchObject({
        ok: false,
        error: "discord.probe.getMe: JSON response timed out after 50ms",
      });

      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(terminationCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds stalled application-summary response bodies during probes", async () => {
    vi.useFakeTimers();
    try {
      let terminationCount = 0;
      const fetcher = withFetchPreconnect(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/users/@me")) {
          return jsonResponse({ id: "bot-1", username: "openclaw" });
        }
        return trackedStalledDiscordJsonResponse(init?.signal, () => {
          terminationCount += 1;
        });
      });

      const probe = probeDiscord("MTIz.abc.def", 50, {
        fetcher,
        includeApplication: true,
      });
      const outerStatusResult = Promise.race([
        probe,
        new Promise<{ ok: false; timedOut: true }>((resolve) => {
          setTimeout(() => resolve({ ok: false, timedOut: true }), 50);
        }),
      ]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);

      await expect(outerStatusResult).resolves.toMatchObject({
        ok: true,
        bot: { id: "bot-1", username: "openclaw" },
      });
      expect(terminationCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds stalled application-id response bodies", async () => {
    vi.useFakeTimers();
    try {
      let terminationCount = 0;
      const fetcher = withFetchPreconnect(async (_input, init) =>
        trackedStalledDiscordJsonResponse(init?.signal, () => {
          terminationCount += 1;
        }),
      );

      const lookup = fetchDiscordApplicationId("unparseable.token", 50, fetcher);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(50);

      await expect(lookup).resolves.toBeUndefined();
      expect(terminationCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives application id from parseable tokens before probing REST", async () => {
    let calls = 0;
    const fetcher = withFetchPreconnect(async () => {
      calls += 1;
      return new Response("<html><title>Error 1015</title></html>", {
        status: 429,
        headers: { "content-type": "text/html" },
      });
    });

    await expect(fetchDiscordApplicationId("MTIz.abc.def", 1_000, fetcher)).resolves.toBe("123");
    expect(calls).toBe(0);
  });
});
