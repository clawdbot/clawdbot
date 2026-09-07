import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryActive } from "../../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider }>;
};

const SHARE_ROUTE = {
  kind: "thread-id-prefix",
  routeSegment: "shared-sessions",
  hostId: "gateway",
  identifierAlphabet: "lowercase-hex",
  fullLength: 32,
  minPrefixLength: 12,
  lookup: "catalog-list-search-by-thread-id-prefix",
  ambiguity: "multiple-results-or-next-cursor",
} as const satisfies NonNullable<SessionCatalogProvider["shareRoute"]>;

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  listSessionEntriesReadOnly: vi.fn(() => []),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return { ...actual, listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly };
});
vi.mock("../../state/user-profiles.js", () => ({
  hasMultipleSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
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

async function listCatalogs(params: unknown = {}) {
  const respond = vi.fn();
  await sessionCatalogHandlers["sessions.catalog.list"]?.({
    params,
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as never);
  return respond;
}

describe("session catalog share routes", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
    hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
    hoisted.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
  });

  it("projects uniquely owned routes and suppresses collisions", async () => {
    hoisted.activeRegistry.sessionCatalogs.push({
      provider: provider("external", { shareRoute: SHARE_ROUTE }),
    });
    let catalogs = (
      (await listCatalogs({ catalogId: "external" })).mock.calls[0]![1] as {
        catalogs: Array<{ shareRoute?: unknown }>;
      }
    ).catalogs;
    expect(catalogs[0]?.shareRoute).toEqual(SHARE_ROUTE);

    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("first", { shareRoute: SHARE_ROUTE }) },
      { provider: provider("second", { shareRoute: SHARE_ROUTE }) },
    ];
    catalogs = ((await listCatalogs()).mock.calls[0]![1] as { catalogs: typeof catalogs }).catalogs;
    expect(catalogs.every((catalog) => catalog.shareRoute === undefined)).toBe(true);
  });

  it.each(["chat", "focus", "plugin", "settings"])(
    "does not project the reserved %s route",
    async (routeSegment) => {
      hoisted.activeRegistry.sessionCatalogs = [
        {
          provider: provider("external", {
            shareRoute: { ...SHARE_ROUTE, routeSegment },
          }),
        },
      ];

      const respond = await listCatalogs({ catalogId: "external" });

      expect(respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.not.objectContaining({ shareRoute: expect.anything() })],
      });
    },
  );
});
