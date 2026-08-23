import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  listSessionCatalogEntries,
  type SessionCatalogProvider,
} from "../../plugins/session-catalog.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider }>;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  listSessionEntriesReadOnly: vi.fn<
    (scope?: { agentId?: string; clone?: boolean; projection?: "full" | "list" }) => Array<{
      sessionKey: string;
      entry: {
        createdActor?: { type: "human" | "agent" | "system"; id?: string };
        updatedAt?: number;
      };
    }>
  >(() => []),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return { ...actual, listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly };
});

const { sessionCatalogHandlers } = await import("./session-catalog.js");

function provider(id: string, sessionKey: string): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    list: vi.fn(async ({ sessionEntries }) => {
      const entries = listSessionCatalogEntries({
        config: {},
        runtime: createPluginRuntime(),
        sessionEntries,
      });
      const adopted = entries.find((candidate) => candidate.sessionKey === sessionKey);
      return [
        {
          hostId: `gateway:${id}`,
          label: `${id} host`,
          kind: "gateway" as const,
          connected: true,
          sessions: adopted
            ? [
                {
                  threadId: `${id}-thread`,
                  status: "stored" as const,
                  archived: false,
                  sessionKey: adopted.sessionKey,
                  canContinue: true,
                  canArchive: false,
                },
              ]
            : [],
        },
      ];
    }),
  };
}

describe("session catalog entry snapshots", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    hoisted.listSessionEntriesReadOnly.mockReset();
  });

  it("shares one flattened entry snapshot across catalogs and creator projection", async () => {
    hoisted.listSessionEntriesReadOnly.mockReturnValue([
      {
        sessionKey: "agent:main:alpha-adopted",
        entry: { createdActor: { type: "agent", id: "worker-alpha" }, updatedAt: 2 },
      },
      {
        sessionKey: "agent:main:zeta-adopted",
        entry: { createdActor: { type: "system", id: "scheduler" }, updatedAt: 1 },
      },
    ]);
    const flattenedEntries: unknown[] = [];
    for (const catalog of [
      provider("zeta", "agent:main:zeta-adopted"),
      provider("alpha", "agent:main:alpha-adopted"),
    ]) {
      const list = catalog.list;
      catalog.list = vi.fn(async (params) => {
        const result = await list(params);
        flattenedEntries.push(
          listSessionCatalogEntries({
            config: {},
            runtime: createPluginRuntime(),
            sessionEntries: params.sessionEntries,
          }),
        );
        return result;
      });
      hoisted.activeRegistry.sessionCatalogs.push({ provider: catalog });
    }

    const respond = vi.fn();
    await sessionCatalogHandlers["sessions.catalog.list"]?.({
      params: {},
      respond,
      context: { getRuntimeConfig: () => ({}) },
    } as never);

    expect(hoisted.listSessionEntriesReadOnly).toHaveBeenCalledOnce();
    expect(flattenedEntries).toHaveLength(2);
    expect(flattenedEntries[0]).toBe(flattenedEntries[1]);
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        {
          id: "alpha",
          label: "ALPHA",
          capabilities: { continueSession: false, archive: false },
          hosts: [
            {
              hostId: "gateway:alpha",
              label: "alpha host",
              kind: "gateway",
              connected: true,
              sessions: [
                {
                  threadId: "alpha-thread",
                  status: "stored",
                  archived: false,
                  sessionKey: "agent:main:alpha-adopted",
                  canContinue: true,
                  canArchive: false,
                  createdActor: { type: "agent", id: "worker-alpha" },
                },
              ],
            },
          ],
        },
        {
          id: "zeta",
          label: "ZETA",
          capabilities: { continueSession: false, archive: false },
          hosts: [
            {
              hostId: "gateway:zeta",
              label: "zeta host",
              kind: "gateway",
              connected: true,
              sessions: [
                {
                  threadId: "zeta-thread",
                  status: "stored",
                  archived: false,
                  sessionKey: "agent:main:zeta-adopted",
                  canContinue: true,
                  canArchive: false,
                  createdActor: { type: "system", id: "scheduler" },
                },
              ],
            },
          ],
        },
      ],
    });
  });
});
