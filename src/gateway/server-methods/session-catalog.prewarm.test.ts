import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

const hoisted = vi.hoisted(() => ({
  activeRegistry: { sessionCatalogs: [] as unknown[] },
  listSessionEntriesReadOnly: vi.fn(() => []),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly,
}));

const { prewarmSessionCatalogList, sessionCatalogHandlers } = await import("./session-catalog.js");

function provider(
  id: string,
  overrides: Partial<SessionCatalogProvider> = {},
): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

function startList(params: {
  config: Record<string, unknown>;
  request: Record<string, unknown>;
  connId?: string;
  broadcastToConnIds?: ReturnType<typeof vi.fn>;
}) {
  const respond = vi.fn();
  const completion = Promise.resolve(
    sessionCatalogHandlers["sessions.catalog.list"]?.({
      params: params.request,
      respond,
      client: params.connId ? { connId: params.connId } : undefined,
      context: {
        getRuntimeConfig: () => params.config,
        ...(params.broadcastToConnIds ? { broadcastToConnIds: params.broadcastToConnIds } : {}),
      },
    } as never),
  );
  return { completion, respond };
}

describe("session catalog prewarm", () => {
  beforeEach(() => {
    hoisted.activeRegistry.sessionCatalogs = [];
    hoisted.listSessionEntriesReadOnly.mockClear();
  });

  it("serves the first handler call from the warmed list cache", async () => {
    const list = vi.fn(async () => []);
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = { agents: { list: [{ id: "main", default: true }] } };

    await prewarmSessionCatalogList({ config, agentId: "main", limitPerHost: 40 });
    const handler = startList({
      config,
      request: { agentId: "main", limitPerHost: 40 },
    });
    await handler.completion;

    expect(list).toHaveBeenCalledOnce();
    expect(handler.respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "codex", hosts: [] })],
    });
  });

  it("fans out headless-leader progress without leaking subscriptions", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const list = vi.fn(async ({ onHost }: { onHost?: (value: typeof host) => void }) => {
      await gate;
      onHost?.(host);
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const agentId = "prewarm";
    const config = { agents: { list: [{ id: agentId, default: true }] } };
    const followerBroadcast = vi.fn();

    try {
      const prewarm = prewarmSessionCatalogList({
        config,
        agentId,
        limitPerHost: 40,
      });
      await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
      const follower = startList({
        config,
        request: {
          agentId,
          limitPerHost: 40,
          progressId: "follower-progress",
        },
        connId: "follower",
        broadcastToConnIds: followerBroadcast,
      });

      expect(list).toHaveBeenCalledOnce();
      release();
      await Promise.all([prewarm, follower.completion]);

      expect(followerBroadcast).toHaveBeenCalledOnce();
      expect(follower.respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
      });

      now += 2_500;
      const settledFollowerBroadcast = vi.fn();
      const settledFollower = startList({
        config,
        request: { agentId, limitPerHost: 40, progressId: "settled-progress" },
        connId: "settled",
        broadcastToConnIds: settledFollowerBroadcast,
      });
      await settledFollower.completion;
      expect(settledFollowerBroadcast).not.toHaveBeenCalled();

      now += 501;
      const nextBroadcast = vi.fn();
      const next = startList({
        config,
        request: { agentId, limitPerHost: 40, progressId: "next-progress" },
        connId: "next",
        broadcastToConnIds: nextBroadcast,
      });
      await next.completion;
      expect(list).toHaveBeenCalledTimes(2);
      expect(nextBroadcast).toHaveBeenCalledOnce();
      expect(followerBroadcast).toHaveBeenCalledOnce();
    } finally {
      release();
      nowSpy.mockRestore();
    }
  });
});
