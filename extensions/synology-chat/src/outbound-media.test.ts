// Synology Chat tests cover guarded outbound attachment staging and same-route capability serving.
import fs from "node:fs";
import type { HostedOutboundMediaChunkRecord } from "openclaw/plugin-sdk/outbound-media";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import type { loadWebMedia as loadWebMediaType } from "openclaw/plugin-sdk/web-media";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSynologyHostedMediaRoute } from "./hosted-media-route.js";
import {
  prepareSynologyHostedMedia,
  tryHandleSynologyHostedMediaRequest,
} from "./outbound-media.js";
import { setSynologyRuntime } from "./runtime.js";
import { makeReq, makeRes as makeBaseRes } from "./test-http-utils.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn<typeof loadWebMediaType>());

function makeRes(options: { finishOnEnd?: boolean } = {}) {
  const res = makeBaseRes(options);
  const chunks: Buffer[] = [];
  const end = res.end.bind(res);
  res.write = ((chunk: Uint8Array | string) => {
    chunks.push(Buffer.from(chunk));
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: Uint8Array | string) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.from(chunk));
    }
    end(chunks.length > 0 ? Buffer.concat(chunks) : undefined);
    return res;
  }) as typeof res.end;
  return res;
}

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: loadWebMediaMock,
}));

const testStateDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(() => {
    resetPluginStateStoreForTests();
    cleanup();
  });
});
// Each test gets clean SQLite state; reopen cases retain it within that test.
const testStateDir = testStateDirs.make(
  "openclaw-synology-media-",
  resolvePreferredOpenClawTmpDir(),
);
const testStateEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: testStateDir,
};

function createAccount(overrides: Partial<ResolvedSynologyChatAccount> = {}) {
  return {
    accountId: "default",
    enabled: true,
    token: "token",
    incomingUrl: "https://nas.example.com/incoming",
    webhookUrl: "https://gateway.example.com/public/synology?proxy-token=keep",
    nasHost: "nas.example.com",
    webhookPath: "/internal/synology",
    webhookPathSource: "explicit" as const,
    dangerouslyAllowNameMatching: false,
    dangerouslyAllowInheritedWebhookPath: false,
    dmPolicy: "allowlist" as const,
    allowedUserIds: ["42"],
    rateLimitPerMinute: 30,
    botName: "OpenClaw",
    allowInsecureSsl: false,
    ...overrides,
  } satisfies ResolvedSynologyChatAccount;
}

function installRuntime() {
  const openedStores: Array<ReturnType<typeof createPluginStateKeyedStoreForTests>> = [];
  let registerCallCount = 0;
  const openKeyedStore = vi.fn((options: OpenKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests("synology-chat", {
      ...options,
      env: testStateEnv,
    });
    const register = store.register.bind(store);
    store.register = async (key, value, opts) => {
      registerCallCount += 1;
      await register(key, value, opts);
    };
    openedStores.push(store);
    return store;
  });
  setSynologyRuntime({ state: { openKeyedStore } } as unknown as PluginRuntime);
  return { openKeyedStore, openedStores, getRegisterCallCount: () => registerCallCount };
}

function internalCapabilityUrl(publicUrl: string, pathName = "/internal/synology"): string {
  return `${pathName}${new URL(publicUrl).search}`;
}

function utf16Buffer(value: string, endian: "le" | "be", includeBom = true): Buffer {
  const buffer = Buffer.from(`${includeBom ? "\ufeff" : ""}${value}`, "utf16le");
  return endian === "le" ? buffer : buffer.swap16();
}

function utf32Buffer(value: string, endian: "le" | "be", includeBom = true): Buffer {
  const codePoints = Array.from(value, (character) => character.codePointAt(0) ?? 0xfffd);
  const bomBytes = includeBom ? 4 : 0;
  const buffer = Buffer.alloc(bomBytes + codePoints.length * 4);
  if (includeBom) {
    if (endian === "le") {
      buffer.writeUInt32LE(0xfeff, 0);
    } else {
      buffer.writeUInt32BE(0xfeff, 0);
    }
  }
  codePoints.forEach((codePoint, index) => {
    const offset = bomBytes + index * 4;
    if (endian === "le") {
      buffer.writeUInt32LE(codePoint, offset);
    } else {
      buffer.writeUInt32BE(codePoint, offset);
    }
  });
  return buffer;
}

describe("Synology Chat hosted outbound media", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
    fs.mkdirSync(testStateDir, { recursive: true });
    installRuntime();
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("frozen-image-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "floor-plan.png",
    });
    vi.useRealTimers();
  });

  it("requires an exact public HTTPS callback without credentials or fragments", () => {
    const credentialedUrl = new URL("https://gateway.example.com/webhook");
    credentialedUrl.username = "fixture-user";
    credentialedUrl.password = "fixture-password";
    expect(() => resolveSynologyHostedMediaRoute(createAccount({ webhookUrl: "" }))).toThrow(
      "attachments require webhookUrl",
    );
    expect(() =>
      resolveSynologyHostedMediaRoute(
        createAccount({ webhookUrl: "http://gateway.example.com/webhook" }),
      ),
    ).toThrow("must be an absolute HTTPS URL");
    expect(() =>
      resolveSynologyHostedMediaRoute(createAccount({ webhookUrl: credentialedUrl.toString() })),
    ).toThrow("must be an absolute HTTPS URL");
    expect(() =>
      resolveSynologyHostedMediaRoute(
        createAccount({
          webhookUrl:
            "https://gateway.example.com/webhook?__openclaw_synology_media_token_existing=value",
        }),
      ),
    ).toThrow("must not contain query parameters starting with");
  });

  it("preserves an exact public callback path with a trailing slash", async () => {
    const prepared = await prepareSynologyHostedMedia({
      account: createAccount({
        webhookUrl: "https://gateway.example.com/public/synology/?proxy-token=keep",
      }),
      mediaUrl: "https://files.example.com/floor-plan.png",
    });

    expect(new URL(prepared.url).pathname).toBe("/public/synology/");
  });

  it("freezes source bytes and serves repeat GET/HEAD requests on the internal route", async () => {
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/floor-plan.png",
    });
    expect(prepared.url).toMatch(
      /^https:\/\/gateway\.example\.com\/public\/synology\?proxy-token=keep&__openclaw_synology_media_token_[a-f0-9]{24}=/u,
    );
    expect(prepared.url).not.toContain("files.example.com");
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);

    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("changed-source-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "changed.png",
    });
    const requestUrl = internalCapabilityUrl(prepared.url);
    const head = makeRes();
    await expect(
      tryHandleSynologyHostedMediaRequest(makeReq("HEAD", "", { url: requestUrl }), head, account),
    ).resolves.toBe(true);
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-disposition"]).toContain("attachment");
    expect(head.headers["content-disposition"]).toContain("floor-plan.png");
    expect(head.headers["x-content-type-options"]).toBe("nosniff");
    expect(head.headers["cache-control"]).toBe("no-store");

    for (let index = 0; index < 2; index += 1) {
      const get = makeRes();
      await tryHandleSynologyHostedMediaRequest(
        makeReq("GET", "", { url: requestUrl }),
        get,
        account,
      );
      expect(get.statusCode).toBe(200);
      expect(Buffer.from(get.body).toString("utf8")).toBe("frozen-image-bytes");
    }
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });

  it("reconstructs persisted bytes before honoring response backpressure", async () => {
    const { openedStores } = installRuntime();
    const frozenBytes = Buffer.alloc(40 * 1024, 0x61);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: frozenBytes,
      kind: undefined,
      contentType: "application/pdf",
      fileName: "report.pdf",
    });
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const chunkStore = openedStores[1] as
      | PluginStateKeyedStore<HostedOutboundMediaChunkRecord>
      | undefined;
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const chunkLookup = vi.spyOn(chunkStore, "lookup");
    const response = makeRes();
    const write = response.write.bind(response);
    let firstWrite = true;
    response.write = ((chunk: Uint8Array | string) => {
      write(chunk);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    }) as typeof response.write;
    let settled = false;

    const serving = tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      response,
      account,
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(chunkLookup).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    response.emit("drain");
    await expect(serving).resolves.toBe(true);
    expect(chunkLookup).toHaveBeenCalledTimes(2);
    expect(Buffer.from(response.body)).toEqual(frozenBytes);
  });

  it("rejects a corrupt persisted payload before writing response bytes", async () => {
    const { openedStores } = installRuntime();
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.alloc(40 * 1024, 0x61),
      kind: undefined,
      contentType: "application/pdf",
      fileName: "report.pdf",
    });
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const chunkStore = openedStores[1] as
      | PluginStateKeyedStore<HostedOutboundMediaChunkRecord>
      | undefined;
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const originalLookup = chunkStore.lookup.bind(chunkStore);
    vi.spyOn(chunkStore, "lookup").mockImplementation(async (key) => {
      const chunk = await originalLookup(key);
      return chunk?.index === 1
        ? { ...chunk, dataBase64: Buffer.from("oversized").toString("base64") }
        : chunk;
    });
    const response = makeRes({ finishOnEnd: false });
    const writeSpy = vi.spyOn(response, "write");

    await expect(
      tryHandleSynologyHostedMediaRequest(
        makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
        response,
        account,
      ),
    ).resolves.toBe(true);

    expect(response.statusCode).toBe(404);
    expect(response.destroyed).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("never treats capability query values as an on-demand fetch target", async () => {
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/floor-plan.png",
    });
    const requestUrl = new URL(internalCapabilityUrl(prepared.url), "http://localhost");
    requestUrl.searchParams.set("url", "http://127.0.0.1/private");
    requestUrl.searchParams.set("target", "https://files.example.com/changed.png");
    const response = makeRes();

    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: `${requestUrl.pathname}${requestUrl.search}` }),
      response,
      account,
    );

    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.body).toString("utf8")).toBe("frozen-image-bytes");
    expect(response.headers).not.toHaveProperty("location");
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);

    const targetOnly = makeRes();
    await expect(
      tryHandleSynologyHostedMediaRequest(
        makeReq("GET", "", { url: "/internal/synology?target=http://127.0.0.1/private" }),
        targetOnly,
        account,
      ),
    ).resolves.toBe(false);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });

  it("propagates guarded-load rejection without creating a capability", async () => {
    loadWebMediaMock.mockRejectedValueOnce(
      new Error("Blocked hostname or private/internal IP address"),
    );

    await expect(
      prepareSynologyHostedMedia({
        account: createAccount(),
        mediaUrl: "https://rebind.example.test/private",
      }),
    ).rejects.toThrow("Blocked hostname or private/internal IP address");
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });

  it("keeps preparation limits after a fresh runtime initializes its stores", async () => {
    let releaseLoads: (() => void) | undefined;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoads = resolve;
    });
    loadWebMediaMock.mockImplementation(async () => {
      await loadGate;
      return {
        buffer: Buffer.from("frozen-image-bytes"),
        kind: "image",
        contentType: "image/png",
        fileName: "floor-plan.png",
      };
    });
    const account = createAccount();
    const first = prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/one.png",
    });
    const second = prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/two.png",
    });
    await vi.waitFor(() => expect(loadWebMediaMock).toHaveBeenCalledTimes(2));

    const third = prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/three.png",
    });
    await Promise.resolve();
    releaseLoads?.();

    await expect(third).rejects.toThrow("attachment preparation is busy");
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed for wrong tokens, accounts, routes, and unsupported methods", async () => {
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const capability = new URL(prepared.url);
    const tokenKey = [...capability.searchParams.keys()].find((key) =>
      key.startsWith("__openclaw_synology_media_token_"),
    );
    if (!tokenKey) {
      throw new Error("expected Synology hosted media token");
    }

    const wrongToken = new URLSearchParams(capability.search);
    wrongToken.set(tokenKey, "wrong");
    const unauthorized = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: `/internal/synology?${wrongToken.toString()}` }),
      unauthorized,
      account,
    );
    expect(unauthorized.statusCode).toBe(401);

    const crossAccount = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      crossAccount,
      createAccount({ accountId: "other" }),
    );
    expect(crossAccount.statusCode).toBe(404);

    const crossRoute = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url, "/other") }),
      crossRoute,
      account,
    );
    expect(crossRoute.statusCode).toBe(404);

    const method = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("POST", "", { url: internalCapabilityUrl(prepared.url) }),
      method,
      account,
    );
    expect(method.statusCode).toBe(405);
  });

  it("bounds unauthenticated capability lookups before reading persistent state", async () => {
    const { openedStores } = installRuntime();
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const metadataStore = openedStores[0];
    if (!metadataStore) {
      throw new Error("expected hosted media metadata store");
    }
    const originalLookup = metadataStore.lookup.bind(metadataStore);
    let releaseReads: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const lookupSpy = vi.spyOn(metadataStore, "lookup").mockImplementation(async (key) => {
      await readGate;
      return await originalLookup(key);
    });
    const capability = new URL(internalCapabilityUrl(prepared.url), "http://localhost");
    const tokenKey = [...capability.searchParams.keys()].find((key) =>
      key.startsWith("__openclaw_synology_media_token_"),
    );
    if (!tokenKey) {
      throw new Error("expected Synology hosted media token");
    }
    capability.searchParams.set(tokenKey, "wrong");
    const requestUrl = `${capability.pathname}${capability.search}`;
    const responses = Array.from({ length: 5 }, () => makeRes());
    const requests = responses.map((response) =>
      tryHandleSynologyHostedMediaRequest(
        makeReq("GET", "", { url: requestUrl }),
        response,
        account,
      ),
    );

    await vi.waitFor(() => expect(lookupSpy).toHaveBeenCalledTimes(4));
    expect(responses.filter((response) => response.statusCode === 503)).toHaveLength(1);
    releaseReads?.();
    await expect(Promise.all(requests)).resolves.toEqual([true, true, true, true, true]);
    expect(responses.map((response) => response.statusCode).toSorted((a, b) => a - b)).toEqual([
      401, 401, 401, 401, 503,
    ]);
  });

  it("holds serving slots until responses finish or close", async () => {
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const requestUrl = internalCapabilityUrl(prepared.url);
    const stalled = Array.from({ length: 4 }, () => makeRes({ finishOnEnd: false }));
    await Promise.all(
      stalled.map((response) =>
        tryHandleSynologyHostedMediaRequest(
          makeReq("GET", "", { url: requestUrl }),
          response,
          account,
        ),
      ),
    );

    const blocked = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: requestUrl }),
      blocked,
      account,
    );
    expect(blocked.statusCode).toBe(503);

    stalled[0]?.emit("finish");
    const admitted = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: requestUrl }),
      admitted,
      account,
    );
    expect(admitted.statusCode).toBe(200);

    for (const response of stalled.slice(1)) {
      response.emit("close");
    }
  });

  it("keeps serving limits when a fresh runtime reopens persisted capabilities", async () => {
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    installRuntime();
    const requestUrl = internalCapabilityUrl(prepared.url);
    const stalled = Array.from({ length: 5 }, () => makeRes({ finishOnEnd: false }));

    for (const response of stalled) {
      await tryHandleSynologyHostedMediaRequest(
        makeReq("GET", "", { url: requestUrl }),
        response,
        account,
      );
    }

    expect(stalled.slice(0, 4).map((response) => response.statusCode)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(stalled[4]?.statusCode).toBe(503);
    for (const response of stalled.slice(0, 4)) {
      response.emit("close");
    }
  });

  it("closes stalled attachment responses and releases their serving slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    installRuntime();
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const requestUrl = internalCapabilityUrl(prepared.url);
    const stalled = makeRes({ finishOnEnd: false });
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: requestUrl }),
      stalled,
      account,
    );

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(stalled.destroyed).toBe(true);

    const admitted = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: requestUrl }),
      admitted,
      account,
    );
    expect(admitted.statusCode).toBe(200);
  });

  it("starts the response deadline before persisted metadata can stall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { openedStores } = installRuntime();
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const metadataStore = openedStores[0];
    if (!metadataStore) {
      throw new Error("expected hosted media metadata store");
    }
    const lookup = metadataStore.lookup.bind(metadataStore);
    let markLookupStarted: (() => void) | undefined;
    let releaseLookup: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    vi.spyOn(metadataStore, "lookup").mockImplementationOnce(async (key) => {
      markLookupStarted?.();
      await lookupGate;
      return await lookup(key);
    });
    const response = makeRes({ finishOnEnd: false });
    const pending = tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      response,
      account,
    );

    await lookupStarted;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(response.statusCode).toBe(504);
    expect(Buffer.from(response.body).toString("utf8")).toBe("Attachment response timed out");
    releaseLookup?.();
    await expect(pending).resolves.toBe(true);
    expect(response.statusCode).toBe(504);
  });

  it("bounds repeated authenticated downloads without charging HEAD requests", async () => {
    const { openedStores } = installRuntime();
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.alloc(32 * 1024 * 1024, 0x61),
      kind: undefined,
      contentType: "application/pdf",
      fileName: "report.pdf",
    });
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const requestUrl = internalCapabilityUrl(prepared.url);
    const chunkStore = openedStores[1];
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const chunkReadSpy = vi.spyOn(chunkStore, "lookup");

    for (let index = 0; index < 4; index += 1) {
      const response = makeRes();
      await tryHandleSynologyHostedMediaRequest(
        makeReq("GET", "", { url: requestUrl }),
        response,
        account,
      );
      expect(response.statusCode).toBe(200);
      await Promise.resolve();
    }
    const chunkReadsAtLimit = chunkReadSpy.mock.calls.length;

    const head = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("HEAD", "", { url: requestUrl }),
      head,
      account,
    );
    expect(head.statusCode).toBe(200);

    const limited = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: requestUrl }),
      limited,
      account,
    );
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(chunkReadSpy).toHaveBeenCalledTimes(chunkReadsAtLimit);
  });

  it("persists frozen capabilities across plugin-state reopen and runtime replacement", async () => {
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/floor-plan.png",
    });
    const requestUrl = internalCapabilityUrl(prepared.url);

    resetPluginStateStoreForTests();
    installRuntime();
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("changed-source-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "changed.png",
    });
    const response = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: requestUrl }),
      response,
      account,
    );

    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.body).toString("utf8")).toBe("frozen-image-bytes");
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });

  it("rejects active content and leaves no live capability", async () => {
    const { getRegisterCallCount, openedStores } = installRuntime();
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("<svg onload=alert(1)></svg>"),
      kind: "image",
      contentType: "image/svg+xml",
      fileName: "active.svg",
    });
    await expect(
      prepareSynologyHostedMedia({
        account: createAccount(),
        mediaUrl: "https://files.example.com/active.svg",
      }),
    ).rejects.toThrow("do not support active content type");
    await expect(
      Promise.all(openedStores.map(async (store) => await store.entries())),
    ).resolves.toEqual([[], []]);
    expect(getRegisterCallCount()).toBe(0);
  });

  it.each([
    {
      name: "HTML bytes with a passive MIME and filename",
      buffer: Buffer.from("<script>alert('active')</script>"),
      contentType: "image/png",
      fileName: "photo.png",
    },
    {
      name: "XML-prefixed SVG bytes with generic metadata",
      buffer: Buffer.from('<?xml version="1.0"?><!--fixture--><svg onload="alert(1)"/>'),
      contentType: "application/octet-stream",
      fileName: "diagram.bin",
    },
    {
      name: "SVG doctype bytes with generic metadata",
      buffer: Buffer.from(
        '<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      ),
      contentType: "application/octet-stream",
      fileName: "diagram.bin",
    },
    {
      name: "SVG bytes beyond long whitespace and repeated wrappers",
      buffer: Buffer.from(
        `${" ".repeat(5_000)}${"<!--fixture-->".repeat(6)}<svg onload="alert(1)"/>`,
      ),
      contentType: "application/octet-stream",
      fileName: "diagram.bin",
    },
    {
      name: "UTF-16LE HTML bytes with passive metadata",
      buffer: utf16Buffer("<script>alert('active')</script>", "le"),
      contentType: "image/png",
      fileName: "photo.png",
    },
    {
      name: "UTF-16BE SVG bytes with passive metadata",
      buffer: utf16Buffer('  <!--fixture--><svg onload="alert(1)"/>', "be"),
      contentType: "image/png",
      fileName: "photo.png",
    },
    {
      name: "UTF-16LE XML bytes with passive metadata",
      buffer: utf16Buffer('<?xml version="1.0"?><document/>', "le"),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "UTF-16BE HTML doctype bytes with passive metadata",
      buffer: utf16Buffer("<!DOCTYPE html><html><body>active</body></html>", "be"),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "BOM-less UTF-16LE HTML bytes with generic metadata",
      buffer: utf16Buffer('<img src="x" onerror="alert(1)">', "le", false),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "BOM-less UTF-16BE HTML bytes with generic metadata",
      buffer: utf16Buffer("  <div><script>alert('active')</script></div>", "be", false),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "BOM-less UTF-32LE HTML bytes with generic metadata",
      buffer: utf32Buffer('<embed src="data:text/html,active">', "le", false),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "UTF-32BE SVG bytes with passive metadata",
      buffer: utf32Buffer('<svg onload="alert(1)"/>', "be"),
      contentType: "image/png",
      fileName: "photo.png",
    },
    {
      name: "an unlisted active HTML root with generic metadata",
      buffer: Buffer.from('<object data="data:text/html,active"></object>'),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "an active root whose tag name exceeds the old sniff prefix",
      buffer: Buffer.from(`<${"custom-element-".repeat(8)}>active</custom-element>`),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "a bogus declaration before an active element",
      buffer: Buffer.from("<!fixture><script>alert('active')</script>"),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "an unmatched closing tag before an active element",
      buffer: Buffer.from("</fixture><script>alert('active')</script>"),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "an abruptly closed comment before an active element",
      buffer: Buffer.from("<!--><script>alert('active')</script>"),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "an abruptly closed comment-start-dash before an active element",
      buffer: Buffer.from("<!---><script>alert('active')</script>"),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "an incorrectly closed comment before an active element",
      buffer: Buffer.from("<!--fixture--!><script>alert('active')</script>"),
      contentType: "application/octet-stream",
      fileName: "document.bin",
    },
    {
      name: "an active filename with generic content",
      buffer: Buffer.from("not markup"),
      contentType: "application/octet-stream",
      fileName: "report.html",
    },
  ])("rejects $name", async ({ buffer, contentType, fileName }) => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer,
      kind: undefined,
      contentType,
      fileName,
    });
    await expect(
      prepareSynologyHostedMedia({
        account: createAccount(),
        mediaUrl: "https://files.example.com/disguised-content",
      }),
    ).rejects.toThrow("do not support active content type");
  });

  it.each([
    { endian: "le" as const, includeBom: true },
    { endian: "be" as const, includeBom: true },
    { endian: "le" as const, includeBom: false },
    { endian: "be" as const, includeBom: false },
  ])(
    "keeps passive UTF-16$endian attachments available (BOM: $includeBom)",
    async ({ endian, includeBom }) => {
      const buffer = utf16Buffer("Passive attachment text", endian, includeBom);
      loadWebMediaMock.mockResolvedValueOnce({
        buffer,
        kind: undefined,
        contentType: "text/plain",
        fileName: `notes-${endian}.txt`,
      });
      const account = createAccount();
      const prepared = await prepareSynologyHostedMedia({
        account,
        mediaUrl: `https://files.example.com/notes-${endian}.txt`,
      });
      const response = makeRes();

      await tryHandleSynologyHostedMediaRequest(
        makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
        response,
        account,
      );

      expect(response.statusCode).toBe(200);
      expect(Buffer.from(response.body)).toEqual(buffer);
    },
  );

  it.each([
    {
      name: "UTF-8 source text",
      buffer: Buffer.from("Example source: <div> is a literal tag."),
    },
    {
      name: "BOM-less UTF-32 source text",
      buffer: utf32Buffer("Example source: <div> is a literal tag.", "le", false),
    },
  ])("keeps passive $name containing embedded markup available", async ({ buffer }) => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer,
      kind: undefined,
      contentType: "text/plain",
      fileName: "example.txt",
    });
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/example.txt",
    });
    const response = makeRes();

    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      response,
      account,
    );

    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.body)).toEqual(buffer);
  });

  it("sanitizes response filenames before constructing headers", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("pdf"),
      kind: undefined,
      contentType: "application/pdf",
      fileName: '../quarter\r\nX-Evil: yes/"plan".pdf',
    });
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    const response = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      response,
      account,
    );
    const disposition = response.headers["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(disposition).not.toContain("../");
  });

  it("expires capabilities without falling back to the source URL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    installRuntime();
    const account = createAccount();
    const prepared = await prepareSynologyHostedMedia({
      account,
      mediaUrl: "https://files.example.com/report.pdf",
    });
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000 + 1);
    const response = makeRes();
    await tryHandleSynologyHostedMediaRequest(
      makeReq("GET", "", { url: internalCapabilityUrl(prepared.url) }),
      response,
      account,
    );
    expect(response.statusCode).toBe(404);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });
});
