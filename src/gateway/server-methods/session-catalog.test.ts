import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

const activeRegistry = vi.hoisted(() => ({ sessionCatalogs: [] as unknown[] }));

vi.mock("../../plugins/runtime-state.js", () => ({
  getPluginRegistryState: () => ({ activeRegistry }),
}));

const { resolveSessionCatalogCreateTarget, sessionCatalogHandlers } =
  await import("./session-catalog.js");

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

async function call(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  config: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await sessionCatalogHandlers[method]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => config },
  } as never);
  return respond;
}

describe("session catalog Gateway methods", () => {
  beforeEach(() => {
    activeRegistry.sessionCatalogs = [];
  });

  it("sorts catalogs and isolates provider failures", async () => {
    activeRegistry.sessionCatalogs = [
      { provider: provider("zeta") },
      {
        provider: provider("alpha", {
          list: vi.fn(async () => {
            throw new Error();
          }),
        }),
      },
    ];
    const respond = await call("sessions.catalog.list", {});
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "alpha",
          hosts: [],
          error: { code: "catalog_error", message: "session catalog provider failed" },
        }),
        expect.objectContaining({ id: "zeta", hosts: [] }),
      ],
    });
  });

  it("refreshes a provider's core new-session target when listing", async () => {
    let createSession: { model: string; agentRuntime: string } | undefined = {
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    };
    activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession: () => createSession,
        }),
      },
    ];

    const respond = await call("sessions.catalog.list", {});

    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "claude",
          capabilities: {
            continueSession: false,
            archive: false,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
        }),
      ],
    });

    createSession = undefined;
    const refreshed = await call("sessions.catalog.list", {});
    expect(refreshed).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "claude",
          capabilities: {
            continueSession: false,
            archive: false,
          },
        }),
      ],
    });
  });

  it("keeps creation available when catalog history listing fails", async () => {
    activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession: () => ({
            model: "anthropic/claude-opus-4-8",
            agentRuntime: "claude-cli",
          }),
          list: vi.fn(async () => {
            throw new Error("history unavailable");
          }),
        }),
      },
    ];

    const respond = await call("sessions.catalog.list", {});

    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          capabilities: {
            continueSession: false,
            archive: false,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
          error: { code: "catalog_error", message: "history unavailable" },
        }),
      ],
    });
  });

  it("resolves creation capability for the requested agent", async () => {
    const resolveCreateSession = vi.fn(({ agentId }: { agentId?: string }) =>
      agentId === "research"
        ? { model: "anthropic/claude-opus-4-8", agentRuntime: "claude-cli" }
        : undefined,
    );
    activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", { resolveCreateSession }),
      },
    ];

    const available = await call(
      "sessions.catalog.list",
      {
        agentId: "research",
        catalogId: "claude",
      },
      { agents: { list: [{ id: "main" }, { id: "research" }] } },
    );
    expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "research" });
    expect(available).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          capabilities: {
            continueSession: false,
            archive: false,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
        }),
      ],
    });
  });

  it("resolves the private runtime target separately from the public capability", () => {
    activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession: () => ({
            model: "anthropic/claude-opus-4-8",
            agentRuntime: "claude-cli",
          }),
        }),
      },
    ];

    expect(resolveSessionCatalogCreateTarget("claude", "research")).toEqual({
      ok: true,
      target: {
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
        pluginOwnerId: "anthropic",
      },
    });
    expect(resolveSessionCatalogCreateTarget("missing", "research")).toEqual({
      ok: false,
      message: "unknown session catalog: missing",
      unknownCatalog: true,
    });
  });

  it("dispatches continue by catalog id", async () => {
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:adopted" }));
    activeRegistry.sessionCatalogs = [{ provider: provider("codex", { continueSession }) }];
    const respond = await call("sessions.catalog.continue", {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    expect(continueSession).toHaveBeenCalledWith({
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    expect(respond).toHaveBeenCalledWith(true, { sessionKey: "agent:main:adopted" });
  });

  it("rejects an unknown catalog id when listing", async () => {
    const respond = await call("sessions.catalog.list", { catalogId: "missing" });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "unknown session catalog: missing",
      }),
    );
  });
});
