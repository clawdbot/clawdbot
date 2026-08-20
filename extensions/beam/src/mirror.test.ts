import { createServer, type IncomingMessage, type Server } from "node:http";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import type { ActiveSessionCatalog } from "openclaw/plugin-sdk/session-catalog-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  beamMirrorId,
  buildBeamMirrorItems,
  createBeamMirrorRunner,
  fitBeamMirrorUpload,
  parseBeamMirrorConfig,
  type BeamMirrorUpload,
} from "./mirror.js";
import { BEAM_MAX_ITEMS, parseBeamUpload } from "./types.js";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

function mirrorConfig(overrides: Record<string, unknown> = {}): unknown {
  return {
    plugins: {
      entries: {
        beam: {
          enabled: true,
          config: {
            mirror: {
              endpoint: "https://team.example/api/v1/beam/sessions",
              catalogs: ["claude", "codex", "beam"],
              ...overrides,
            },
          },
        },
      },
    },
  };
}

function fakeCatalog(params: {
  id: string;
  sessions: Array<{ threadId: string; name?: string; recencyAt: number }>;
  items?: SessionCatalogTranscriptItem[];
  hostKind?: string;
  onRead?: (threadId: string) => void;
}): ActiveSessionCatalog {
  const host: SessionCatalogHost = {
    hostId: "gateway:local",
    label: "Local",
    kind: (params.hostKind ?? "gateway") as SessionCatalogHost["kind"],
    connected: true,
    sessions: params.sessions.map((session) => ({
      threadId: session.threadId,
      ...(session.name ? { name: session.name } : {}),
      status: "stored",
      createdAt: NOW - 60_000,
      updatedAt: session.recencyAt,
      recencyAt: session.recencyAt,
      archived: false,
      canContinue: false,
      canArchive: false,
    })),
  };
  return {
    pluginId: params.id,
    id: params.id,
    label: params.id,
    list: async () => [host],
    read: async ({ threadId }): Promise<SessionsCatalogReadResult> => {
      params.onRead?.(threadId);
      return {
        hostId: "gateway:local",
        label: "Local",
        threadId,
        items: params.items ?? [
          { type: "userMessage", text: "Fix the flow." },
          { type: "agentMessage", text: "Done." },
        ],
      };
    },
  };
}

function fakeRuntime(config: unknown): PluginRuntime {
  return { config: { current: () => config } } as unknown as PluginRuntime;
}

type SentRequest = { url: string; auth?: string; payload: BeamMirrorUpload };

function captureFetch(
  sent: SentRequest[],
  status = 200,
  onCancel?: () => void | Promise<void>,
): typeof fetch {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({
      url: String(url),
      ...(headers.Authorization ? { auth: headers.Authorization } : {}),
      payload: JSON.parse(init?.body as string) as BeamMirrorUpload,
    });
    const body = onCancel
      ? new ReadableStream<Uint8Array>({
          cancel: onCancel,
        })
      : "{}";
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

const silentLogger = { warn: () => {}, info: () => {} };

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeTestServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("parseBeamMirrorConfig", () => {
  it("returns undefined without mirror config", () => {
    expect(parseBeamMirrorConfig({ plugins: { entries: { beam: { enabled: true } } } })).toBe(
      undefined,
    );
  });

  it("applies defaults and normalizes catalogs", () => {
    const parsed = parseBeamMirrorConfig(mirrorConfig({ catalogs: [" Claude "] }));
    expect(parsed).toMatchObject({
      endpoint: "https://team.example/api/v1/beam/sessions",
      catalogs: ["claude"],
      pollSeconds: 30,
      activeWindowMinutes: 180,
    });
  });

  it("rejects unknown keys and non-http endpoints", () => {
    expect(typeof parseBeamMirrorConfig(mirrorConfig({ bogus: true }))).toBe("string");
    expect(typeof parseBeamMirrorConfig(mirrorConfig({ endpoint: "ftp://x" }))).toBe("string");
    expect(typeof parseBeamMirrorConfig(mirrorConfig({ endpoint: "not a url" }))).toBe("string");
  });

  it("allows plaintext http only for loopback development endpoints", () => {
    expect(typeof parseBeamMirrorConfig(mirrorConfig({ endpoint: "http://team.example/x" }))).toBe(
      "string",
    );
    expect(
      parseBeamMirrorConfig(mirrorConfig({ endpoint: "http://127.0.0.1:19351/x" })),
    ).toMatchObject({ endpoint: "http://127.0.0.1:19351/x" });
    expect(
      parseBeamMirrorConfig(mirrorConfig({ endpoint: "http://localhost:19351/x" })),
    ).toMatchObject({ endpoint: "http://localhost:19351/x" });
    expect(parseBeamMirrorConfig(mirrorConfig({ endpoint: "http://[::1]:19351/x" }))).toMatchObject(
      {
        endpoint: "http://[::1]:19351/x",
      },
    );
  });

  it("requires explicit catalog consent", () => {
    expect(typeof parseBeamMirrorConfig(mirrorConfig({ catalogs: undefined }))).toBe("string");
    expect(typeof parseBeamMirrorConfig(mirrorConfig({ catalogs: [] }))).toBe("string");
  });

  it("bounds poll and window values", () => {
    const parsed = parseBeamMirrorConfig(
      mirrorConfig({ pollSeconds: 1, activeWindowMinutes: 999_999 }),
    );
    expect(parsed).toMatchObject({ pollSeconds: 10, activeWindowMinutes: 10_080 });
  });
});

describe("buildBeamMirrorItems", () => {
  it("keeps user and agent text, collapses the rest into counts", () => {
    const reduced = buildBeamMirrorItems([
      { type: "userMessage", text: "Fix it." },
      { type: "toolCall", text: "rm -rf /tmp/x", raw: { command: "secret" } },
      { type: "toolResult", raw: { output: "secret output" } },
      { type: "reasoning", text: "private thoughts" },
      { type: "agentMessage", text: "Done." },
    ]);
    expect(reduced.items).toEqual([
      { type: "userMessage", text: "Fix it." },
      {
        type: "other",
        text: "1 tool calls, 1 tool results, 1 reasoning items; raw content dropped",
      },
      { type: "agentMessage", text: "Done." },
    ]);
    expect(reduced.droppedRaw).toBe(3);
    expect(JSON.stringify(reduced.items)).not.toContain("secret");
    expect(JSON.stringify(reduced.items)).not.toContain("private thoughts");
  });

  it("clips oversized message text to the receiver cap", () => {
    const reduced = buildBeamMirrorItems([{ type: "userMessage", text: "x".repeat(10_000) }]);
    expect(reduced.items[0]?.text.length).toBe(6_000);
  });

  it("does not split a surrogate pair when clipping message text", () => {
    const reduced = buildBeamMirrorItems([
      { type: "userMessage", text: `${"x".repeat(5_999)}🙂tail` },
    ]);
    expect(reduced.items[0]?.text).toBe("x".repeat(5_999));
  });
});

describe("fitBeamMirrorUpload", () => {
  it("drops oldest items to satisfy item and byte caps and marks truncation", () => {
    const upload: BeamMirrorUpload = {
      version: 1,
      beamId: "0123456789abcdef0123456789abcdef",
      source: "claude",
      title: "big",
      updatedAt: "2026-07-27T12:00:00.000Z",
      completed: false,
      items: Array.from({ length: 300 }, (_, index) => ({
        type: "agentMessage" as const,
        text: `entry ${index} ${"pad".repeat(200)}`,
      })),
    };
    const fitted = fitBeamMirrorUpload(upload);
    expect(fitted.truncated).toBe(true);
    expect(fitted.items.length).toBeLessThanOrEqual(BEAM_MAX_ITEMS);
    expect(fitted.items.at(-1)?.text).toContain("entry 299");
    expect(Buffer.byteLength(JSON.stringify(fitted), "utf8")).toBeLessThanOrEqual(56 * 1024);
    // The fitted payload must remain acceptable to the receiver.
    expect(parseBeamUpload(structuredClone(fitted)).ok).toBe(true);
  });
});

describe("createBeamMirrorRunner", () => {
  it("does not replay mirror uploads across redirects to another private origin", async () => {
    const redirectedBodies: string[] = [];
    const internalServer = createServer((req, res) => {
      void readRequestBody(req).then(
        (body) => {
          redirectedBodies.push(body);
          res.statusCode = 200;
          res.end("ok");
        },
        (error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    const internalOrigin = await listenOnLoopback(internalServer);
    const receiverBodies: string[] = [];
    const receiverServer = createServer((req, res) => {
      void readRequestBody(req).then(
        (body) => {
          receiverBodies.push(body);
          res.statusCode = 307;
          res.setHeader("Location", `${internalOrigin}/internal-action`);
          res.end();
        },
        (error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    try {
      const receiverOrigin = await listenOnLoopback(receiverServer);
      const runner = createBeamMirrorRunner({
        runtime: fakeRuntime(mirrorConfig({ endpoint: `${receiverOrigin}/beam` })),
        logger: silentLogger,
        now: () => NOW,
        listCatalogs: () => [
          fakeCatalog({ id: "claude", sessions: [{ threadId: "t1", recencyAt: NOW }] }),
        ],
      });

      await runner.tick();

      expect(receiverBodies).toHaveLength(1);
      expect(receiverBodies[0]).toContain("Fix the flow.");
      expect(redirectedBodies).toEqual([]);
    } finally {
      await Promise.all([closeTestServer(receiverServer), closeTestServer(internalServer)]);
    }
  });

  it.each([
    { label: "301", status: 301, location: "/redirected?private=do-not-log" },
    { label: "302", status: 302, location: "/redirected?private=do-not-log" },
    { label: "303", status: 303, location: "/redirected?private=do-not-log" },
    { label: "307", status: 307, location: "/redirected?private=do-not-log" },
    { label: "308", status: 308, location: "/redirected?private=do-not-log" },
    { label: "307 without Location", status: 307, location: undefined },
  ])(
    "blocks a $label redirect without retrying the configured endpoint",
    async ({ status, location }) => {
      const warnings: string[] = [];
      const receiverBodies: string[] = [];
      const redirectedBodies: string[] = [];
      const server = createServer((req, res) => {
        void readRequestBody(req).then(
          (body) => {
            if (req.url === "/redirected") {
              redirectedBodies.push(body);
              res.statusCode = 200;
              res.end("ok");
              return;
            }
            receiverBodies.push(body);
            res.statusCode = status;
            if (location) {
              res.setHeader("Location", location);
            }
            res.end();
          },
          (error: unknown) => {
            res.destroy(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
      try {
        const origin = await listenOnLoopback(server);
        const runner = createBeamMirrorRunner({
          runtime: fakeRuntime(mirrorConfig({ endpoint: `${origin}/beam` })),
          logger: { warn: (message) => warnings.push(message), info: () => {} },
          now: () => NOW,
          listCatalogs: () => [
            fakeCatalog({ id: "claude", sessions: [{ threadId: "t1", recencyAt: NOW }] }),
          ],
        });

        await runner.tick();
        await runner.tick();

        expect(receiverBodies).toHaveLength(1);
        expect(redirectedBodies).toEqual([]);
        expect(warnings).toEqual([
          `beam mirror upload blocked for claude: receiver returned redirect (${status}); redirects are not followed; configure the final endpoint`,
        ]);
        expect(warnings.join(" ")).not.toContain("do-not-log");
      } finally {
        await closeTestServer(server);
      }
    },
  );

  it("logs a terminal redirect block after a recent transient warning", async () => {
    const warnings: string[] = [];
    let requestCount = 0;
    const server = createServer((req, res) => {
      void readRequestBody(req).then(
        () => {
          requestCount += 1;
          res.statusCode = requestCount === 1 ? 503 : 307;
          res.end();
        },
        (error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    try {
      const origin = await listenOnLoopback(server);
      const runner = createBeamMirrorRunner({
        runtime: fakeRuntime(mirrorConfig({ endpoint: `${origin}/beam` })),
        logger: { warn: (message) => warnings.push(message), info: () => {} },
        now: () => NOW,
        listCatalogs: () => [
          fakeCatalog({ id: "claude", sessions: [{ threadId: "t1", recencyAt: NOW }] }),
        ],
      });

      await runner.tick();
      await runner.tick();
      await runner.tick();

      expect(requestCount).toBe(2);
      expect(warnings).toEqual([
        "beam mirror upload failed (503) for claude",
        "beam mirror upload blocked for claude: receiver returned redirect (307); redirects are not followed; configure the final endpoint",
      ]);
    } finally {
      await closeTestServer(server);
    }
  });

  it("rechecks once after runner restart and resumes after the endpoint changes", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      void readRequestBody(req).then(
        () => {
          requests.push(req.url ?? "");
          if (req.url === "/redirecting") {
            res.statusCode = 307;
            res.setHeader("Location", "/redirected");
          } else {
            res.statusCode = 200;
          }
          res.end();
        },
        (error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    try {
      const origin = await listenOnLoopback(server);
      let endpoint = `${origin}/redirecting`;
      const runtime = {
        config: { current: () => mirrorConfig({ endpoint }) },
      } as unknown as PluginRuntime;
      const createRunner = () =>
        createBeamMirrorRunner({
          runtime,
          logger: silentLogger,
          now: () => NOW,
          listCatalogs: () => [
            fakeCatalog({ id: "claude", sessions: [{ threadId: "t1", recencyAt: NOW }] }),
          ],
        });
      const runner = createRunner();

      await runner.tick();
      await runner.tick();
      const restartedRunner = createRunner();
      await restartedRunner.tick();
      endpoint = `${origin}/direct`;
      await restartedRunner.tick();

      expect(requests).toEqual(["/redirecting", "/redirecting", "/direct"]);
    } finally {
      await closeTestServer(server);
    }
  });

  it("uploads active local sessions and skips unchanged ones", async () => {
    const sent: SentRequest[] = [];
    const reads: string[] = [];
    const cancel = vi.fn();
    const catalog = fakeCatalog({
      id: "claude",
      sessions: [{ threadId: "t1", name: "Fix flow", recencyAt: NOW - 60_000 }],
      onRead: (threadId) => reads.push(threadId),
    });
    const runner = createBeamMirrorRunner({
      runtime: fakeRuntime(mirrorConfig({ token: "scratch-token" })),
      logger: silentLogger,
      fetchFn: captureFetch(sent, 200, cancel),
      now: () => NOW,
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(reads).toEqual(["t1", "t1"]);
    expect(sent[0]?.auth).toBe("Bearer scratch-token");
    expect(sent[0]?.payload).toMatchObject({
      version: 1,
      beamId: beamMirrorId("claude", "gateway:local", "t1"),
      source: "claude",
      title: "Fix flow",
      completed: false,
    });
    expect(parseBeamUpload(structuredClone(sent[0]?.payload)).ok).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not split a surrogate pair when clipping the session title", async () => {
    const sent: SentRequest[] = [];
    const catalog = fakeCatalog({
      id: "claude",
      sessions: [{ threadId: "t-emoji", name: `${"x".repeat(159)}🙂`, recencyAt: NOW - 60_000 }],
    });
    const runner = createBeamMirrorRunner({
      runtime: fakeRuntime(mirrorConfig()),
      logger: silentLogger,
      fetchFn: captureFetch(sent),
      now: () => NOW,
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.title).toBe("x".repeat(159));
  });

  it("keeps successful uploads successful when response cancellation rejects", async () => {
    const sent: SentRequest[] = [];
    const warnings: string[] = [];
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const catalog = fakeCatalog({
      id: "claude",
      sessions: [{ threadId: "t1", recencyAt: NOW - 60_000 }],
    });
    const runner = createBeamMirrorRunner({
      runtime: fakeRuntime(mirrorConfig()),
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      fetchFn: captureFetch(sent, 200, cancel),
      now: () => NOW,
      listCatalogs: () => [catalog],
    });

    await runner.tick();
    await runner.tick();

    expect(sent).toHaveLength(1);
    expect(cancel).toHaveBeenCalledOnce();
    expect(warnings).toEqual([]);
  });

  it("bounds guarded uploads and releases their response resources", async () => {
    const cancel = vi.fn();
    const release = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      { status: 200 },
    );
    const guardedFetch = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockResolvedValue({
      response,
      finalUrl: "https://team.example/api/v1/beam/sessions",
      release,
    });
    const runner = createBeamMirrorRunner({
      runtime: fakeRuntime(mirrorConfig()),
      logger: silentLogger,
      now: () => NOW,
      listCatalogs: () => [
        fakeCatalog({ id: "claude", sessions: [{ threadId: "t1", recencyAt: NOW }] }),
      ],
    });

    try {
      await runner.tick();

      expect(guardedFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://team.example/api/v1/beam/sessions",
          timeoutMs: 15_000,
          maxRedirects: 0,
          policy: { allowedOrigins: ["https://team.example"] },
        }),
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    } finally {
      guardedFetch.mockRestore();
    }
  });

  it("ignores idle sessions, node hosts, the beam catalog, and unlisted catalogs", async () => {
    const sent: SentRequest[] = [];
    const idle = fakeCatalog({
      id: "claude",
      sessions: [{ threadId: "old", recencyAt: NOW - 24 * 60 * 60_000 }],
    });
    const nodeHost = fakeCatalog({
      id: "codex",
      sessions: [{ threadId: "remote", recencyAt: NOW }],
      hostKind: "node",
    });
    const beamCatalog = fakeCatalog({
      id: "beam",
      sessions: [{ threadId: "loop", recencyAt: NOW }],
    });
    const unlisted = fakeCatalog({
      id: "pi",
      sessions: [{ threadId: "p1", recencyAt: NOW }],
    });
    const runner = createBeamMirrorRunner({
      runtime: fakeRuntime(mirrorConfig({ catalogs: ["claude", "codex", "beam"] })),
      logger: silentLogger,
      fetchFn: captureFetch(sent),
      now: () => NOW,
      listCatalogs: () => [idle, nodeHost, beamCatalog, unlisted],
    });
    await runner.tick();
    expect(sent).toHaveLength(0);
  });

  it("sends one completed upload when a session leaves the active window", async () => {
    const sent: SentRequest[] = [];
    const recency = NOW - 60_000;
    const catalog = fakeCatalog({ id: "claude", sessions: [] });
    const liveCatalog: ActiveSessionCatalog = {
      ...catalog,
      list: async () => [
        {
          hostId: "gateway:local",
          label: "Local",
          kind: "gateway",
          connected: true,
          sessions: [
            {
              threadId: "t1",
              name: "Fix flow",
              status: "stored",
              createdAt: NOW - 120_000,
              updatedAt: recency,
              recencyAt: recency,
              archived: false,
              canContinue: false,
              canArchive: false,
            },
          ],
        },
      ],
    };
    let clock = NOW;
    const runner = createBeamMirrorRunner({
      runtime: fakeRuntime(mirrorConfig()),
      logger: silentLogger,
      fetchFn: captureFetch(sent),
      now: () => clock,
      listCatalogs: () => [liveCatalog],
    });
    await runner.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.completed).toBe(false);
    // Session goes idle past the window; the next tick finalizes it once.
    clock = NOW + 4 * 60 * 60_000;
    await runner.tick();
    await runner.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload.completed).toBe(true);
    expect(sent[1]?.payload.beamId).toBe(sent[0]?.payload.beamId);
  });

  it("keeps tracking for retry when the receiver rejects an upload", async () => {
    const sent: SentRequest[] = [];
    const warnings: string[] = [];
    const cancel = vi.fn();
    const catalog = fakeCatalog({
      id: "claude",
      sessions: [{ threadId: "t1", recencyAt: NOW - 60_000 }],
    });
    const runner = createBeamMirrorRunner({
      runtime: fakeRuntime(mirrorConfig()),
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      fetchFn: captureFetch(sent, 503, cancel),
      now: () => NOW,
      listCatalogs: () => [catalog],
    });
    await runner.tick();
    await runner.tick();
    // Both ticks retry because the failed upload was never fingerprinted.
    expect(sent).toHaveLength(2);
    expect(warnings.length).toBeGreaterThan(0);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("skips ticks when a configured token cannot be resolved", async () => {
    const sent: SentRequest[] = [];
    const runner = createBeamMirrorRunner({
      runtime: fakeRuntime(
        mirrorConfig({ token: { source: "env", provider: "default", id: "BEAM_MISSING_TOKEN" } }),
      ),
      logger: silentLogger,
      env: {},
      fetchFn: captureFetch(sent),
      now: () => NOW,
      listCatalogs: () => [
        fakeCatalog({ id: "claude", sessions: [{ threadId: "t1", recencyAt: NOW }] }),
      ],
    });
    await runner.tick();
    expect(sent).toHaveLength(0);
  });
});
