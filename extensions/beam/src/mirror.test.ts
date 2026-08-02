import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  SessionCatalogHost,
  SessionCatalogTranscriptItem,
  SessionsCatalogReadResult,
} from "openclaw/plugin-sdk/session-catalog";
import type { ActiveSessionCatalog } from "openclaw/plugin-sdk/session-catalog-runtime";
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
  return (async (url: unknown, init?: RequestInit) => {
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
  }) as typeof fetch;
}

const silentLogger = { warn: () => {}, info: () => {} };

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
