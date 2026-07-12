import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

const activeRegistry = vi.hoisted(() => ({ sessionCatalogs: [] as unknown[] }));

vi.mock("../../plugins/runtime-state.js", () => ({
  getPluginRegistryState: () => ({ activeRegistry }),
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");

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

async function call(method: keyof typeof sessionCatalogHandlers, params: unknown) {
  const respond = vi.fn();
  await sessionCatalogHandlers[method]?.({ params, respond } as never);
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
