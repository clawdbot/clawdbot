import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
} from "../../config/sessions/session-entry-provenance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import {
  listSessionCatalogEntries,
  type SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import * as userProfiles from "../../state/user-profiles.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";

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
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    hoisted.listSessionEntriesReadOnly.mockReset();
  });

  it("shares resolved and missing human profiles across hosts without retaining them across requests", () => {
    let label = "Before rename";
    const display = vi.spyOn(userProfiles, "getUserProfileDisplay").mockImplementation((id) => {
      if (id !== "person") {
        throw new Error("Missing fixture profile");
      }
      return { id: "current-person", displayName: label, avatarRevision: "1", hasAvatar: true };
    });
    const hosts = ["alpha", "beta"].map((id) => ({
      hostId: `gateway:${id}`,
      label: id,
      kind: "gateway" as const,
      connected: true,
      sessions: ["person", "missing"].map((actorId) => ({
        threadId: `${id}-${actorId}`,
        sessionKey: `agent:main:${id}-${actorId}`,
        status: "stored" as const,
        archived: false,
        canContinue: true,
        canArchive: false,
      })),
    }));
    hoisted.listSessionEntriesReadOnly.mockReturnValue(
      hosts.flatMap((host) =>
        host.sessions.map((session, index) => ({
          sessionKey: session.sessionKey,
          entry: {
            createdVia: "operator",
            createdActor: { type: "human" as const, id: index === 0 ? "person" : "missing" },
          },
        })),
      ),
    );
    const project = () => {
      const snapshot = createSessionCatalogRequestEntrySnapshot({
        cfg: {},
        fallbackAgentId: "main",
      });
      return hosts.map((host) =>
        snapshot.projectHostCreatedActors(host).sessions.map((session) => session.createdActor),
      );
    };
    const expectedActors = () => [
      {
        type: "human",
        id: "person",
        identity: { type: "profile", id: "current-person" },
        label,
        avatarUrl: "/api/users/current-person/avatar?v=1",
      },
      { type: "human", id: "missing", identity: { type: "profile", id: "missing" } },
    ];

    expect(project()).toEqual([expectedActors(), expectedActors()]);
    expect(display).toHaveBeenCalledTimes(2);

    label = "After rename";
    expect(project()).toEqual([expectedActors(), expectedActors()]);
    expect(display).toHaveBeenCalledTimes(4);
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
                  createdActor: {
                    type: "agent",
                    id: "worker-alpha",
                    identity: { type: "agent", id: "worker-alpha" },
                  },
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
                  createdActor: {
                    type: "system",
                    id: "scheduler",
                    identity: {
                      type: "legacy",
                      actorType: "system",
                      id: "scheduler",
                      source: null,
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("projects inherited profile creators from stored provenance, not provider metadata", () => {
    const display = vi.spyOn(userProfiles, "getUserProfileDisplay").mockReturnValue({
      id: "current",
      displayName: "Current",
      avatarRevision: "1",
      hasAvatar: false,
    });
    const creation = buildSessionCreationStamp({
      via: "spawn",
      ...inheritSessionCreationPolicy(
        { createdActor: { type: "human", id: "former" }, sandbox: "required" },
        { type: "agent", id: "research" },
      ),
      now: 1,
    });
    const entries = [
      { sessionKey: "agent:main:child", entry: { ...creation, updatedAt: 1 } },
      {
        sessionKey: "agent:main:channel",
        entry: { ...creation, createdVia: "channel", updatedAt: 1 },
      },
    ];
    hoisted.listSessionEntriesReadOnly.mockReturnValue(entries);
    const snapshot = createSessionCatalogRequestEntrySnapshot({ cfg: {}, fallbackAgentId: "main" });
    const projected = snapshot.projectHostCreatedActors({
      hostId: "gateway:fixture",
      label: "Fixture",
      kind: "gateway",
      connected: true,
      sessions: entries.map(({ sessionKey }) => ({
        sessionKey,
        threadId: sessionKey,
        status: "stored",
        archived: false,
        canContinue: true,
        canArchive: false,
        createdActor: { type: "human", id: "provider-spoof" },
      })),
    });
    expect(projected.sessions.map((session) => session.createdActor)).toEqual([
      {
        type: "human",
        id: "former",
        identity: { type: "profile", id: "current" },
        label: "Current",
      },
      {
        type: "human",
        id: "former",
        identity: { type: "legacy", actorType: "human", source: null, id: "former" },
      },
    ]);
    expect(display).toHaveBeenCalledExactlyOnceWith("former");
  });
});
