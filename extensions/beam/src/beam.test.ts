import { once } from "node:events";
import http from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBeamTestCatalog, createBeamTestRunner } from "./beam.test-support.js";
import { createBeamRequestHandler } from "./http.js";
import { createBeamSessionCatalog } from "./session-catalog.js";
import { createBeamStore, type BeamStore } from "./store.js";
import {
  BEAM_MAX_BODY_BYTES,
  BEAM_MAX_SESSIONS,
  BEAM_RETENTION_MS,
  parseBeamUpload,
  type BeamStoredSession,
} from "./types.js";

type BeamUploadFixture = Omit<BeamStoredSession, "createdAt" | "receivedAt">;

function sampleUpload(overrides: Record<string, unknown> = {}): BeamUploadFixture {
  return {
    version: 1,
    beamId: "0123456789abcdef0123456789abcdef",
    source: "claude",
    title: "Fix the upload flow",
    updatedAt: "2026-07-20T12:00:00.000Z",
    completed: false,
    items: [
      { type: "userMessage", text: "Please fix the upload flow." },
      { type: "agentMessage", text: "Implemented and tested." },
    ],
    ...overrides,
  } as BeamUploadFixture;
}

function postUpload(endpoint: string, body = sampleUpload()) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const writeClient = () => ({ clientIp: "127.0.0.1", scopes: ["operator.write"] });
const rootControlUiBasePath = () => undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function memoryStore(): BeamStore & { values: Map<string, BeamStoredSession> } {
  const values = new Map<string, BeamStoredSession>();
  return {
    values,
    update: async (beamId, updateValue) => {
      const next = updateValue(values.get(beamId));
      if (!next) {
        return false;
      }
      values.set(beamId, next);
      return true;
    },
    get: async (beamId) => values.get(beamId),
    list: async () => [...values.values()],
  };
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function requestStatus(
  url: string,
  options: { method: string; headers: Record<string, string>; body: string },
): Promise<number | undefined> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: options.method, headers: options.headers },
      (response) => {
        resolve(response.statusCode);
        response.resume();
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

async function serve(
  store: BeamStore,
  options: Partial<Parameters<typeof createBeamRequestHandler>[0]> = {},
  intercept?: (
    requestNumber: number,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => boolean,
): Promise<string> {
  const handler = createBeamRequestHandler({
    resolveClient: writeClient,
    resolveControlUiBasePath: rootControlUiBasePath,
    ...options,
    store,
  });
  let requestNumber = 0;
  const server = http.createServer((req, res) => {
    requestNumber += 1;
    if (intercept?.(requestNumber, req, res)) {
      return;
    }
    void handler(req, res).catch((error: unknown) => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : "test handler failed");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}/api/v1/beam/sessions`;
}

describe("Beam payload validation", () => {
  it("accepts the closed normalized payload", () => {
    const upload = sampleUpload({
      sourceModel: { provider: "OpenAI", model: "gpt-5.6-sol" },
    });
    const result = parseBeamUpload(upload);
    expect(result).toEqual({
      ok: true,
      value: sampleUpload({ sourceModel: { provider: "openai", model: "gpt-5.6-sol" } }),
    });
  });

  it("accepts timezone-bearing ISO timestamps with four-digit low years", () => {
    expect(parseBeamUpload(sampleUpload({ updatedAt: "0099-01-01T00:00:00Z" }))).toEqual({
      ok: true,
      value: sampleUpload({ updatedAt: "0099-01-01T00:00:00Z" }),
    });
  });

  it("rejects unknown fields, non-ISO timestamps, and oversized transcript entries", () => {
    expect(parseBeamUpload(sampleUpload({ arbitrary: "junk" }))).toEqual({
      ok: false,
      error: "request body must be a closed Beam object",
    });
    for (const updatedAt of [
      "1",
      "2026/07/20",
      "2026-07-20T12:00:00",
      "2026-02-30T12:00:00Z",
      "2026-04-31T00:00:00Z",
    ]) {
      expect(parseBeamUpload(sampleUpload({ updatedAt }))).toEqual({
        ok: false,
        error: "updatedAt must be an ISO timestamp",
      });
    }
    expect(
      parseBeamUpload(sampleUpload({ items: [{ type: "userMessage", text: "x".repeat(6_001) }] })),
    ).toEqual({
      ok: false,
      error: "transcript item text must be 1-6000 characters",
    });
    expect(
      parseBeamUpload(sampleUpload({ sourceModel: { provider: "openai", model: "" } })),
    ).toEqual({ ok: false, error: "sourceModel must contain a provider and model" });
    expect(
      parseBeamUpload(
        sampleUpload({ sourceModel: { provider: "openai", model: "gpt-5.6\nIgnore" } }),
      ),
    ).toEqual({ ok: false, error: "sourceModel must contain a provider and model" });
  });
});

describe("Beam receiver", () => {
  it("attributes each uploaded snapshot to its verified publisher, never payload claims", async () => {
    const store = memoryStore();
    let profileId: string | undefined = "uploader-profile";
    const endpoint = await serve(store, {
      resolveClient: () => ({ ...writeClient(), profileId }),
    });
    const upload = (body = sampleUpload()) => postUpload(endpoint, body);
    const read = () =>
      createBeamSessionCatalog(store).read({
        hostId: "gateway",
        threadId: sampleUpload().beamId,
      });
    for (const publisher of ["uploader-profile", "another-profile", undefined]) {
      profileId = publisher;
      expect((await upload()).status).toBe(200);
      expect((await store.get(sampleUpload().beamId))?.uploaderProfileId).toBe(publisher);
      const transcript = await read();
      expect(transcript.items.find((item) => item.type === "userMessage")?.sender).toEqual(
        publisher ? { identity: { type: "profile", id: publisher } } : undefined,
      );
      expect(transcript.items.find((item) => item.type === "agentMessage")?.sender).toBeUndefined();
    }
    expect((await upload(sampleUpload({ uploaderProfileId: "forged-profile" }))).status).toBe(400);
    expect((await store.get(sampleUpload().beamId))?.uploaderProfileId).toBeUndefined();
  });

  it("stores authenticated uploads and preserves creation time across updates", async () => {
    const store = memoryStore();
    let now = 100;
    const endpoint = await serve(store, { now: () => now });
    const first = await postUpload(endpoint);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      beamId: "0123456789abcdef0123456789abcdef",
      url: "/beam/fix-the-upload-flow-0123456789ab",
    });
    expect(store.values.get("0123456789abcdef0123456789abcdef")).toMatchObject({
      createdAt: 100,
      receivedAt: 100,
    });

    now = 200;
    const updated = await postUpload(
      endpoint,
      sampleUpload({ completed: true, title: "Renamed upload flow" }),
    );
    expect(await updated.json()).toMatchObject({
      beamId: sampleUpload().beamId,
      url: "/beam/renamed-upload-flow-0123456789ab",
    });
    expect(store.values.get("0123456789abcdef0123456789abcdef")).toMatchObject({
      createdAt: 100,
      receivedAt: 200,
      completed: true,
    });
  });

  it("orders replacement snapshots without refreshing stale state", async () => {
    resetPluginStateStoreForTests();
    const keyedStore = createPluginStateKeyedStoreForTests<BeamStoredSession>("beam", {
      namespace: "sessions",
      maxEntries: BEAM_MAX_SESSIONS,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: BEAM_RETENTION_MS,
      env: { OPENCLAW_STATE_DIR: tempDirs.make("beam-snapshot-ordering-") },
    });
    const store = createBeamStore({
      state: { openKeyedStore: () => keyedStore },
    } as unknown as PluginRuntime);
    let receivedAt = 100;
    let profileId = "terminal-publisher";
    const endpoint = await serve(store, {
      now: () => receivedAt,
      resolveClient: () => ({ ...writeClient(), profileId }),
    });
    const updatedAt = "2026-07-20T12:00:00.000100Z";
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const upload = async (
      overrides: Record<string, unknown>,
      options: { storedAt: number; receivedAt: number; profileId?: string },
    ) => {
      dateNow.mockReturnValue(options.storedAt);
      receivedAt = options.receivedAt;
      profileId = options.profileId ?? profileId;
      const body = sampleUpload(overrides);
      expect((await postUpload(endpoint, body)).status).toBe(200);
      return await store.get(body.beamId);
    };
    const entryFor = async (beamId: string) =>
      (await keyedStore.entries()).find((entry) => entry.key === beamId);

    try {
      const terminal = await upload(
        {
          updatedAt,
          completed: true,
          title: "Terminal snapshot",
          sourceModel: { provider: "openai", model: "gpt-5.6-sol" },
          items: [{ type: "userMessage", text: "terminal request" }],
        },
        { storedAt: 1_000, receivedAt: 100 },
      );
      expect(terminal).toMatchObject({
        title: "Terminal snapshot",
        items: [{ type: "userMessage", text: "terminal request" }],
        sourceModel: { provider: "openai", model: "gpt-5.6-sol" },
        uploaderProfileId: "terminal-publisher",
        createdAt: 100,
      });
      const terminalEntry = await entryFor(sampleUpload().beamId);
      expect(terminalEntry).toMatchObject({
        createdAt: 1_000,
        expiresAt: 1_000 + BEAM_RETENTION_MS,
      });

      for (const [candidateUpdatedAt, title, completed, storedAt, candidateReceivedAt] of [
        ["2026-07-20T11:59:59.999Z", "Stale snapshot", false, 2_000, 200],
        ["2026-07-20T12:00:00.000050Z", "Sub-millisecond stale snapshot", true, 2_500, 250],
        ["2026-07-20T08:00:00.000100-04:00", "Equal live snapshot", false, 3_000, 300],
      ] as const) {
        await upload(
          {
            updatedAt: candidateUpdatedAt,
            title,
            completed,
            items: [{ type: "agentMessage", text: title }],
          },
          { storedAt, receivedAt: candidateReceivedAt, profileId: "stale-publisher" },
        );
        expect(await store.get(sampleUpload().beamId)).toEqual(terminal);
        expect(await entryFor(sampleUpload().beamId)).toEqual(terminalEntry);
      }

      const catalog = createBeamSessionCatalog(store);
      await expect(
        catalog.copyToGatewaySession?.({
          agentId: "main",
          hostId: "gateway",
          threadId: sampleUpload().beamId,
        }),
      ).resolves.toEqual({
        displayName: "Terminal snapshot",
        preferredModel: "openai/gpt-5.6-sol",
      });
      await expect(
        catalog.read({
          agentId: "main",
          hostId: "gateway",
          threadId: sampleUpload().beamId,
        }),
      ).resolves.toMatchObject({
        label: "Terminal snapshot",
        items: [
          expect.objectContaining({
            type: "userMessage",
            text: "terminal request",
            sender: { identity: { type: "profile", id: "terminal-publisher" } },
          }),
        ],
      });

      expect(
        await upload(
          {
            updatedAt,
            completed: true,
            title: "Refreshed terminal snapshot",
            sourceModel: { provider: "anthropic", model: "claude-opus-4-1" },
            items: [{ type: "agentMessage", text: "refreshed terminal" }],
          },
          { storedAt: 4_000, receivedAt: 400, profileId: "terminal-refresh-publisher" },
        ),
      ).toMatchObject({
        completed: true,
        title: "Refreshed terminal snapshot",
        items: [{ type: "agentMessage", text: "refreshed terminal" }],
        sourceModel: { provider: "anthropic", model: "claude-opus-4-1" },
        uploaderProfileId: "terminal-refresh-publisher",
        createdAt: 100,
        receivedAt: 400,
      });
      expect(await entryFor(sampleUpload().beamId)).toMatchObject({
        createdAt: 4_000,
        expiresAt: 4_000 + BEAM_RETENTION_MS,
      });

      expect(
        await upload(
          {
            updatedAt: "2026-07-20T12:00:00.000200Z",
            title: "Reopened snapshot",
            sourceModel: { provider: "openai", model: "gpt-5.6-sol" },
            items: [{ type: "agentMessage", text: "reopened" }],
          },
          { storedAt: 5_000, receivedAt: 500, profileId: "reopen-publisher" },
        ),
      ).toMatchObject({
        completed: false,
        title: "Reopened snapshot",
        items: [{ type: "agentMessage", text: "reopened" }],
        sourceModel: { provider: "openai", model: "gpt-5.6-sol" },
        uploaderProfileId: "reopen-publisher",
        createdAt: 100,
        receivedAt: 500,
      });
      expect(await entryFor(sampleUpload().beamId)).toMatchObject({
        createdAt: 5_000,
        expiresAt: 5_000 + BEAM_RETENTION_MS,
      });

      const secondBeamId = "fedcba9876543210fedcba9876543210";
      expect(
        await upload({ beamId: secondBeamId, updatedAt }, { storedAt: 6_000, receivedAt: 600 }),
      ).toMatchObject({ completed: false });
      expect(
        await upload(
          {
            beamId: secondBeamId,
            updatedAt,
            completed: true,
            title: "Equal completed snapshot",
          },
          { storedAt: 7_000, receivedAt: 700, profileId: "completion-publisher" },
        ),
      ).toMatchObject({
        completed: true,
        title: "Equal completed snapshot",
        uploaderProfileId: "completion-publisher",
        createdAt: 600,
        receivedAt: 700,
      });
      expect(await entryFor(secondBeamId)).toMatchObject({
        createdAt: 7_000,
        expiresAt: 7_000 + BEAM_RETENTION_MS,
      });
    } finally {
      dateNow.mockRestore();
      resetPluginStateStoreForTests();
    }
  });

  it("returns a Beam share URL beneath a nested Control UI base path", async () => {
    const store = memoryStore();
    const endpoint = await serve(store, {
      resolveControlUiBasePath: () => "/admin/openclaw/",
    });
    const response = await postUpload(endpoint);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      beamId: "0123456789abcdef0123456789abcdef",
      url: "/admin/openclaw/beam/fix-the-upload-flow-0123456789ab",
    });
  });

  it("requires operator.write before reading the upload body", async () => {
    const store = memoryStore();
    const endpoint = await serve(store, {
      resolveClient: () => ({ clientIp: "127.0.0.1", scopes: ["operator.read"] }),
    });
    const response = await postUpload(endpoint);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "operator.write is required" });
    expect(store.values.size).toBe(0);
  });

  it("rejects method, media type, malformed JSON, and oversized bodies", async () => {
    const store = memoryStore();
    const endpoint = await serve(store);
    expect((await fetch(endpoint)).status).toBe(405);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      await requestStatus(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(BEAM_MAX_BODY_BYTES) }),
      }),
    ).toBe(413);
    expect(store.values.size).toBe(0);
  });

  it("closes a declared oversized upload without waiting for its body", async () => {
    const store = memoryStore();
    const endpoint = await serve(store);
    const request = http.request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": BEAM_MAX_BODY_BYTES + 1,
        connection: "keep-alive",
      },
    });
    const responseReady = once(request, "response");
    const closed = once(request, "close");
    request.flushHeaders();
    try {
      const [response] = (await responseReady) as [http.IncomingMessage];
      response.resume();
      expect(response.statusCode).toBe(413);
      expect(response.headers.connection).toBe("close");
      await closed;
      expect(store.values.size).toBe(0);
    } finally {
      request.destroy();
    }
  });
});

describe("Beam mirror receiver boundary", () => {
  it("retries a rejected terminal upload through the real loopback receiver", async () => {
    const store = memoryStore();
    const requests: string[] = [];
    const endpoint = await serve(store, {}, (requestNumber, req, res) => {
      const status = requestNumber === 2 ? 503 : 200;
      requests.push(`${requestNumber === 1 ? "live" : "completed"}:${status}`);
      if (status === 200) {
        return false;
      }
      req.resume();
      res.statusCode = status;
      res.end("temporary receiver failure");
      return true;
    });
    let active = true;
    let clock = Date.parse("2026-07-20T12:00:00.000Z");
    let readCount = 0;
    const catalog = createBeamTestCatalog({
      sessions: () =>
        active
          ? [
              {
                threadId: "terminal-retry-proof",
                name: "Terminal retry proof",
                recencyAt: clock - 60_000,
              },
            ]
          : [],
      onRead: () => {
        readCount += 1;
      },
      items: () => [{ type: "agentMessage", text: `Receiver-boundary proof ${readCount}.` }],
    });
    const runner = createBeamTestRunner({
      endpoint,
      now: () => clock,
      listCatalogs: () => [catalog],
    });

    try {
      await runner.tick();
      active = false;
      clock += 4 * 60 * 60_000;
      await runner.tick();
      expect([...store.values.values()][0]?.completed).toBe(false);
      expect([...store.values.values()][0]?.items[0]?.text).toBe("Receiver-boundary proof 1.");

      await runner.tick();

      expect(requests).toEqual(["live:200", "completed:503", "completed:200"]);
      expect([...store.values.values()][0]?.completed).toBe(true);
      expect([...store.values.values()][0]?.items[0]?.text).toBe("Receiver-boundary proof 3.");
    } finally {
      await runner.stop();
    }
  });
});

describe("Beam session catalog", () => {
  it("queries Beam ids by strict share-prefix without choosing between collisions", async () => {
    const store = memoryStore();
    const ids = [
      "0123456789ab00000000000000000000",
      "0123456789abffffffffffffffffffff",
      "fedcba9876543210fedcba9876543210",
    ];
    for (const [index, beamId] of ids.entries()) {
      await store.update(beamId, () => ({
        ...sampleUpload({ beamId, title: `Beam ${String(index)}` }),
        createdAt: index,
        receivedAt: index,
      }));
    }
    const catalog = createBeamSessionCatalog(store);

    const [ambiguous] = await catalog.list({
      agentId: "main",
      search: "0123456789ab",
      limitPerHost: 2,
    });
    expect(ambiguous?.sessions.map((session) => session.threadId)).toEqual(
      expect.arrayContaining(ids.slice(0, 2)),
    );

    const [unique] = await catalog.list({
      agentId: "main",
      search: "fedcba987654",
      limitPerHost: 2,
    });
    expect(unique?.sessions.map((session) => session.threadId)).toEqual([ids[2]]);

    const [exact] = await catalog.list({ agentId: "main", search: ids[2], limitPerHost: 2 });
    expect(exact?.sessions.map((session) => session.threadId)).toEqual([ids[2]]);

    const [missing] = await catalog.list({
      agentId: "main",
      search: "aaaaaaaaaaaa",
      limitPerHost: 2,
    });
    expect(missing?.sessions).toEqual([]);
  });

  it("lists newest sessions and reads paginated transcript items for Gateway continuation", async () => {
    const store = memoryStore();
    await store.update(sampleUpload().beamId, () => ({
      ...sampleUpload({
        truncated: true,
        sourceModel: { provider: "openai", model: "gpt-5.6-sol" },
        items: [
          ...sampleUpload().items,
          { type: "userMessage", text: "Did the upload keep the conversation order?" },
          { type: "agentMessage", text: "Yes, the question still precedes its answer." },
        ],
      }),
      createdAt: 100,
      receivedAt: 200,
    }));
    await store.update("fedcba9876543210fedcba9876543210", () => ({
      ...sampleUpload({
        beamId: "fedcba9876543210fedcba9876543210",
        title: "Older Codex session",
        source: "codex",
        completed: true,
      }),
      createdAt: 50,
      receivedAt: 100,
    }));
    const catalog = createBeamSessionCatalog(store);

    const [host] = await catalog.list({ agentId: "main", limitPerHost: 1 });
    expect(host).toBeDefined();
    if (!host) {
      throw new Error("Beam catalog did not return its gateway host");
    }
    expect(host.sessions).toHaveLength(1);
    expect(host.sessions[0]).toMatchObject({
      threadId: "0123456789abcdef0123456789abcdef",
      status: "live",
      source: "claude",
      canContinue: true,
      canArchive: false,
    });
    expect(host.nextCursor).toBe("1");
    expect(catalog.audience).toBe("gateway-operators");

    await expect(
      catalog.copyToGatewaySession?.({
        agentId: "main",
        hostId: "gateway",
        threadId: "0123456789abcdef0123456789abcdef",
      }),
    ).resolves.toEqual({
      displayName: "Fix the upload flow",
      preferredModel: "openai/gpt-5.6-sol",
    });

    const transcript = await catalog.read({
      agentId: "main",
      hostId: "gateway",
      threadId: "0123456789abcdef0123456789abcdef",
      limit: 2,
    });
    expect(transcript.items).toEqual([
      expect.objectContaining({
        id: "0123456789abcdef0123456789abcdef:3",
        type: "agentMessage",
        text: "Yes, the question still precedes its answer.",
      }),
      expect.objectContaining({
        id: "0123456789abcdef0123456789abcdef:2",
        type: "userMessage",
        text: "Did the upload keep the conversation order?",
      }),
    ]);
    expect(transcript.items[0]).not.toHaveProperty("truncated");
    expect(transcript.nextCursor).toEqual(expect.any(String));

    const older = await catalog.read({
      agentId: "main",
      hostId: "gateway",
      threadId: "0123456789abcdef0123456789abcdef",
      limit: 2,
      cursor: transcript.nextCursor,
    });
    expect(older.items).toEqual([
      expect.objectContaining({ type: "agentMessage", text: "Implemented and tested." }),
      expect.objectContaining({ type: "userMessage", text: "Please fix the upload flow." }),
    ]);
    expect(older.nextCursor).toBeUndefined();

    const current = store.values.get("0123456789abcdef0123456789abcdef");
    if (!current) {
      throw new Error("Beam test store lost the current session");
    }
    expect(current.items.slice(0, 2)).toEqual(sampleUpload().items);
    await store.update(current.beamId, () => ({
      ...current,
      items: [
        ...current.items.slice(1),
        { type: "agentMessage", text: "Appended after first page." },
      ],
      receivedAt: 200,
    }));

    await expect(
      catalog.read({
        agentId: "main",
        hostId: "gateway",
        threadId: "0123456789abcdef0123456789abcdef",
        limit: 1,
        cursor: transcript.nextCursor,
      }),
    ).rejects.toThrow("stale Beam transcript cursor");
    expect(catalog.archive).toBeUndefined();
    expect(catalog.openTerminal).toBeUndefined();
  });
});
