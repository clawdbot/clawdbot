import http from "node:http";
import type { ActiveSessionCatalog } from "openclaw/plugin-sdk/session-catalog-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createBeamRequestHandler } from "./http.js";
import { createBeamMirrorRunner } from "./mirror.js";
import { createBeamSessionCatalog } from "./session-catalog.js";
import type { BeamStore } from "./store.js";
import { BEAM_MAX_BODY_BYTES, parseBeamUpload, type BeamStoredSession } from "./types.js";

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

const writeClient = () => ({ clientIp: "127.0.0.1", scopes: ["operator.write"] });
const mainControlUiTarget = () => ({ agentId: "main" });

function memoryStore(): BeamStore & { values: Map<string, BeamStoredSession> } {
  const values = new Map<string, BeamStoredSession>();
  return {
    values,
    put: async (session) => {
      values.set(session.beamId, session);
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
  handler: ReturnType<typeof createBeamRequestHandler>,
  intercept?: (
    requestNumber: number,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => boolean,
): Promise<string> {
  let requestNumber = 0;
  const server = http.createServer((req, res) => {
    requestNumber += 1;
    if (intercept?.(requestNumber, req, res)) {
      return;
    }
    void handler(req, res)
      .then((handled) => {
        if (!handled && !res.writableEnded) {
          res.statusCode = 404;
          res.end("Not Found");
        }
      })
      .catch((error: unknown) => {
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

function mirrorRuntime(endpoint: string): Parameters<typeof createBeamMirrorRunner>[0]["runtime"] {
  return {
    config: {
      current: () => ({
        plugins: {
          entries: {
            beam: {
              enabled: true,
              config: {
                mirror: {
                  endpoint,
                  catalogs: ["claude"],
                  pollSeconds: 30,
                  activeWindowMinutes: 180,
                },
              },
            },
          },
        },
      }),
    },
  };
}

describe("Beam payload validation", () => {
  it("accepts the closed normalized payload", () => {
    const result = parseBeamUpload(sampleUpload());
    expect(result).toEqual({ ok: true, value: sampleUpload() });
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
  });
});

describe("Beam receiver", () => {
  it("stores authenticated uploads and preserves creation time across updates", async () => {
    const store = memoryStore();
    let now = 100;
    const endpoint = await serve(
      createBeamRequestHandler({
        store,
        now: () => now,
        resolveClient: writeClient,
        resolveControlUiTarget: mainControlUiTarget,
      }),
    );
    const first = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleUpload()),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      beamId: "0123456789abcdef0123456789abcdef",
      url: "/chat/main?catalog=beam&host=gateway&thread=0123456789abcdef0123456789abcdef",
    });
    expect(store.values.get("0123456789abcdef0123456789abcdef")).toMatchObject({
      createdAt: 100,
      receivedAt: 100,
    });

    now = 200;
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleUpload({ completed: true })),
    });
    expect(store.values.get("0123456789abcdef0123456789abcdef")).toMatchObject({
      createdAt: 100,
      receivedAt: 200,
      completed: true,
    });
  });

  it("returns a catalog URL beneath a nested base path for the configured default agent", async () => {
    const store = memoryStore();
    const endpoint = await serve(
      createBeamRequestHandler({
        store,
        resolveClient: writeClient,
        resolveControlUiTarget: () => ({
          agentId: "research",
          basePath: "/admin/openclaw/",
        }),
      }),
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleUpload()),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      beamId: "0123456789abcdef0123456789abcdef",
      url: "/admin/openclaw/chat/research?catalog=beam&host=gateway&thread=0123456789abcdef0123456789abcdef",
    });
  });

  it("requires operator.write before reading the upload body", async () => {
    const store = memoryStore();
    const endpoint = await serve(
      createBeamRequestHandler({
        store,
        resolveClient: () => ({ clientIp: "127.0.0.1", scopes: ["operator.read"] }),
        resolveControlUiTarget: mainControlUiTarget,
      }),
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleUpload()),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "operator.write is required" });
    expect(store.values.size).toBe(0);
  });

  it("rejects method, media type, malformed JSON, and oversized bodies", async () => {
    const store = memoryStore();
    const endpoint = await serve(
      createBeamRequestHandler({
        store,
        resolveClient: writeClient,
        resolveControlUiTarget: mainControlUiTarget,
      }),
    );
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
});

describe("Beam mirror receiver boundary", () => {
  it("retries a rejected terminal upload through the real loopback receiver", async () => {
    const store = memoryStore();
    const requests: string[] = [];
    const endpoint = await serve(
      createBeamRequestHandler({
        store,
        resolveClient: writeClient,
        resolveControlUiTarget: mainControlUiTarget,
      }),
      (requestNumber, req, res) => {
        const status = requestNumber === 2 ? 503 : 200;
        requests.push(`${requestNumber === 1 ? "live" : "completed"}:${status}`);
        if (status === 200) {
          return false;
        }
        req.resume();
        res.statusCode = status;
        res.end("temporary receiver failure");
        return true;
      },
    );
    let active = true;
    let clock = Date.parse("2026-07-20T12:00:00.000Z");
    let readCount = 0;
    const catalog: ActiveSessionCatalog = {
      pluginId: "claude",
      id: "claude",
      label: "Claude",
      processHomeFallbackAllowed: true,
      list: async () => [
        {
          hostId: "gateway:local",
          label: "Local",
          kind: "gateway",
          connected: true,
          sessions: active
            ? [
                {
                  threadId: "terminal-retry-proof",
                  name: "Terminal retry proof",
                  status: "stored",
                  createdAt: clock - 60_000,
                  updatedAt: clock - 60_000,
                  recencyAt: clock - 60_000,
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ]
            : [],
        },
      ],
      read: async ({ hostId, threadId }) => {
        readCount += 1;
        return {
          hostId,
          label: "Local",
          threadId,
          items: [{ type: "agentMessage", text: `Receiver-boundary proof ${readCount}.` }],
        };
      },
    };
    const runner = createBeamMirrorRunner({
      runtime: mirrorRuntime(endpoint),
      logger: { warn: () => {}, info: () => {} },
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
  it("lists newest sessions and reads paginated transcript items without mutation capabilities", async () => {
    const store = memoryStore();
    await store.put({
      ...sampleUpload({ truncated: true }),
      createdAt: 100,
      receivedAt: 200,
    });
    await store.put({
      ...sampleUpload({
        beamId: "fedcba9876543210fedcba9876543210",
        title: "Older Codex session",
        source: "codex",
        completed: true,
      }),
      createdAt: 50,
      receivedAt: 100,
    });
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
      canContinue: false,
      canArchive: false,
    });
    expect(host.nextCursor).toBe("1");

    const transcript = await catalog.read({
      agentId: "main",
      hostId: "gateway",
      threadId: "0123456789abcdef0123456789abcdef",
      limit: 1,
    });
    expect(transcript.items).toEqual([
      expect.objectContaining({ type: "agentMessage", text: "Implemented and tested." }),
    ]);
    expect(transcript.items[0]).not.toHaveProperty("truncated");
    expect(transcript.nextCursor).toEqual(expect.any(String));

    const older = await catalog.read({
      agentId: "main",
      hostId: "gateway",
      threadId: "0123456789abcdef0123456789abcdef",
      limit: 1,
      cursor: transcript.nextCursor,
    });
    expect(older.items).toEqual([
      expect.objectContaining({ type: "userMessage", text: "Please fix the upload flow." }),
    ]);
    expect(older.nextCursor).toBeUndefined();

    const current = store.values.get("0123456789abcdef0123456789abcdef");
    if (!current) {
      throw new Error("Beam test store lost the current session");
    }
    await store.put({
      ...current,
      items: [
        ...current.items.slice(1),
        { type: "agentMessage", text: "Appended after first page." },
      ],
      receivedAt: 200,
    });

    await expect(
      catalog.read({
        agentId: "main",
        hostId: "gateway",
        threadId: "0123456789abcdef0123456789abcdef",
        limit: 1,
        cursor: transcript.nextCursor,
      }),
    ).rejects.toThrow("stale Beam transcript cursor");
    expect(catalog.continueSession).toBeUndefined();
    expect(catalog.archive).toBeUndefined();
    expect(catalog.openTerminal).toBeUndefined();
  });
});
