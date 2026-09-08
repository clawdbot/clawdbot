import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import type { OfficialExternalPluginCatalogEntry } from "./official-external-plugin-catalog.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  bundledEntries: undefined as OfficialExternalPluginCatalogEntry[] | undefined,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./official-external-plugin-catalog.js")>();
  return {
    ...actual,
    listOfficialExternalPluginCatalogEntries: () =>
      mocks.bundledEntries ?? actual.listOfficialExternalPluginCatalogEntries(),
    loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
      mocks.officialCatalog(...args),
  };
});

const { clearManagedPluginOfficialCatalogCache } = await import("./management-catalog.js");
const { listManagedPlugins, resolveManagedPluginIconSource } =
  await import("./management-service.js");

function metadataSnapshot(params: {
  id?: string;
  name?: string;
  origin?: "bundled" | "global";
  packageName?: string | null;
  installRecord?: Record<string, unknown>;
  featured?: boolean;
  description?: string;
  iconPath?: string;
}) {
  const id = params.id ?? "workboard";
  const packageName =
    params.packageName === null ? undefined : (params.packageName ?? `@openclaw/${id}`);
  const rootDir = `/tmp/${id}`;
  const installOwner = params.installRecord ? id : undefined;
  const manifest = recordPluginManifestInstallOwner(
    {
      id,
      name: params.name ?? "Workboard",
      description: params.description ?? "Coordinate agent work in a shared board.",
      catalog: { featured: params.featured ?? true, order: 10 },
      ...(params.iconPath ? { iconPath: params.iconPath } : {}),
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      origin: params.origin ?? "bundled",
      rootDir,
      source: `${rootDir}/index.ts`,
      manifestPath: `${rootDir}/openclaw.plugin.json`,
    },
    installOwner,
  );
  const installRecord = params.installRecord
    ? { ...params.installRecord, installPath: rootDir }
    : undefined;
  return {
    index: {
      plugins: [
        recordInstalledPluginIndexInstallOwner(
          {
            pluginId: id,
            ...(packageName ? { packageName } : {}),
            origin: params.origin ?? "bundled",
            rootDir,
            enabled: true,
          },
          installOwner,
        ),
      ],
      installRecords: installRecord ? { [id]: installRecord } : {},
    },
    byPluginId: new Map([[id, manifest]]),
    plugins: [manifest],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

function emptyMetadataSnapshot() {
  return {
    index: { plugins: [], installRecords: {} },
    byPluginId: new Map(),
    plugins: [],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

function hostedCatalog(entries: unknown[]) {
  return {
    source: "hosted",
    entries,
    feed: { schemaVersion: 1, id: "test", generatedAt: "now", sequence: 1, entries: [] },
    metadata: { url: "https://clawhub.ai/feed", status: 200, checksum: "hash" },
  };
}

function hostedFeedEntry(params: {
  packageName: string;
  title: string;
  featured?: boolean;
  featuredAt?: number;
  pluginId?: string;
  catalogFeatured?: boolean;
  order?: number;
  description?: string;
  icon?: string;
}) {
  return {
    id: params.packageName,
    title: params.title,
    ...(params.description ? { description: params.description } : {}),
    ...(params.icon ? { icon: params.icon } : {}),
    state: "available",
    ...(params.featured === undefined ? {} : { featured: params.featured }),
    ...(params.featuredAt === undefined ? {} : { featuredAt: params.featuredAt }),
    publisher: { id: "openclaw", trust: "official" },
    install: {
      candidates: [
        {
          sourceRef: "public-clawhub",
          package: params.packageName,
          version: "1.0.0",
          integrity: `sha256:${"b".repeat(64)}`,
        },
      ],
    },
    ...(params.pluginId
      ? {
          openclaw: {
            plugin: { id: params.pluginId, label: params.title },
            catalog: {
              ...(params.catalogFeatured === undefined ? {} : { featured: params.catalogFeatured }),
              ...(params.order === undefined ? {} : { order: params.order }),
            },
          },
        }
      : {}),
  };
}

// Composition fixtures preserve array occurrences that the native catalog producer deduplicates.
function compositionEntry(
  id: string,
  install: { clawhubSpec?: string; npmSpec?: string; localPath?: string } = {},
  { order = 7 }: { order?: number } = {},
) {
  return {
    featured: true,
    openclaw: {
      plugin: { id, label: id },
      catalog: { featured: true, order },
      install,
    },
  };
}

const hostedFeedDiffsEntry = hostedFeedEntry({
  packageName: "@openclaw/diffs",
  title: "Diffs",
  featured: true,
});
const hostedImpostorEntry = hostedFeedEntry({
  packageName: "@community/impostor",
  title: "Impostor",
  featured: false,
  pluginId: "workboard",
  catalogFeatured: false,
});

describe("plugin management Featured authority", () => {
  it("projects listing metadata from a top-level hosted feed entry", async () => {
    const icon = "https://cdn.example.test/expedia.png";
    const officialCatalog = {
      entries: [
        hostedFeedEntry({
          packageName: "@expediagroup/expedia-openclaw",
          title: "Expedia Travel",
          featured: true,
          pluginId: "@expediagroup/expedia-openclaw",
          order: 10,
          description: "Search flights, stays, and travel options.",
          icon,
        }),
      ],
    };
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

    const catalog = await listManagedPlugins({ config: {}, env: {}, officialCatalog });
    const resolved = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "@expediagroup/expedia-openclaw",
    });

    expect(catalog.plugins[0]).toMatchObject({
      id: "@expediagroup/expedia-openclaw",
      name: "Expedia Travel",
      description: "Search flights, stays, and travel options.",
      featured: true,
      order: 10,
    });
    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(resolved).toBeUndefined();
  });

  beforeEach(() => {
    mocks.bundledEntries = undefined;
    clearManagedPluginOfficialCatalogCache();
    mocks.metadata.mockReset();
    mocks.officialCatalog.mockReset();
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([]));
  });

  it("lets a live unfeature override bundled metadata without removing installability", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([{ ...hostedFeedDiffsEntry, featured: false }]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        featured: false,
        order: 40,
        install: { source: "official", pluginId: "diffs" },
      }),
    ]);
  });

  it("treats a legacy hosted row without featured as unfeatured", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([
        hostedFeedEntry({
          packageName: "@openclaw/diffs",
          title: "Diffs",
        }),
      ]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins[0]).toMatchObject({
      id: "diffs",
      featured: false,
      install: { source: "official", pluginId: "diffs" },
    });
  });

  it("surfaces a newly featured live official package without static fallback metadata", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([
        hostedFeedEntry({
          packageName: "@openclaw/new-tool",
          title: "New Tool",
          featured: true,
        }),
      ]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "@openclaw/new-tool",
        name: "New Tool",
        featured: true,
        install: { source: "official", pluginId: "@openclaw/new-tool" },
      }),
    ]);
  });

  it("orders live featured packages by when they were featured", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([
        hostedFeedEntry({
          packageName: "@openclaw/older-popular",
          title: "Older Popular",
          featured: true,
          featuredAt: 100,
          order: 1,
        }),
        hostedFeedEntry({
          packageName: "@openclaw/newest-featured",
          title: "Newest Featured",
          featured: true,
          featuredAt: 200,
          order: 99,
        }),
        hostedFeedEntry({
          packageName: "@openclaw/legacy-featured",
          title: "Legacy Featured",
          featured: true,
          order: 0,
        }),
      ]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins.map((plugin) => plugin.id)).toEqual([
      "@openclaw/newest-featured",
      "@openclaw/older-popular",
      "@openclaw/legacy-featured",
    ]);
    expect(catalog.plugins.map((plugin) => plugin.featuredAt)).toEqual([200, 100, undefined]);
  });

  it("clears stale embedded curation on an unmatched live official package", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([
        hostedFeedEntry({
          packageName: "@openclaw/new-tool",
          title: "New Tool",
          featured: false,
          pluginId: "new-tool",
          catalogFeatured: true,
          order: 80,
        }),
      ]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "new-tool",
        featured: false,
        order: 80,
      }),
    ]);
  });

  it("clears stale embedded curation on a matched package without bundled curation", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([
        hostedFeedEntry({
          packageName: "@openclaw/copilot",
          title: "Copilot",
          featured: false,
          pluginId: "copilot",
          catalogFeatured: true,
          order: 80,
        }),
      ]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "copilot",
        featured: false,
        order: 80,
      }),
    ]);
  });

  it("lets a live unfeature override an installed published plugin manifest", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "diffs",
        name: "Diffs",
        origin: "global",
        installRecord: { source: "npm", spec: "@openclaw/diffs" },
      }),
    );
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([{ ...hostedFeedDiffsEntry, featured: false }]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        installed: true,
        featured: false,
        order: 40,
      }),
    ]);
  });

  it("applies live ClawHub curation to a bundled-known npm installation", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "diffs",
        name: "Diffs",
        origin: "global",
        installRecord: { source: "npm", spec: "@openclaw/diffs" },
        featured: false,
      }),
    );
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([hostedFeedDiffsEntry]));

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        featured: true,
        order: 40,
      }),
    ]);
  });

  it.each([
    { id: "workboard", name: "Workboard", packageName: "@openclaw/workboard" },
    { id: "memory-wiki", name: "Memory Wiki", packageName: "@openclaw/memory-wiki" },
  ])("keeps local curation for private bundled-only $name", async (plugin) => {
    mocks.metadata.mockReturnValue(metadataSnapshot(plugin));
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([
        hostedFeedEntry({
          packageName: `@community/${plugin.id}`,
          title: "Impostor",
          featured: false,
          pluginId: plugin.id,
          catalogFeatured: false,
        }),
      ]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: plugin.id,
        name: plugin.name,
        packageName: plugin.packageName,
        featured: true,
        order: 10,
      }),
    ]);
  });

  it("applies hosted curation to the exact published package for bundled FireCrawl", async () => {
    const hostedIcon = "https://cdn.example.test/firecrawl-company.png";
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "firecrawl",
        name: "firecrawl",
        packageName: "@openclaw/firecrawl-plugin",
        featured: false,
        description: "Optional OpenClaw capability.",
      }),
    );
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([
        hostedFeedEntry({
          packageName: "@openclaw/firecrawl-plugin",
          title: "FireCrawl",
          featured: true,
          featuredAt: 1_784_280_000_000,
          pluginId: "firecrawl",
          description: "Crawl, scrape, search, and extract web content with FireCrawl.",
          icon: hostedIcon,
        }),
      ]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });
    const resolvedIcon = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "firecrawl",
    });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "firecrawl",
        name: "FireCrawl",
        description: "Crawl, scrape, search, and extract web content with FireCrawl.",
        packageName: "@openclaw/firecrawl-plugin",
        featured: true,
        featuredAt: 1_784_280_000_000,
        order: 10,
      }),
    ]);
    expect(catalog.plugins[0]).not.toHaveProperty("hasIcon");
    expect(resolvedIcon).toBeUndefined();
  });

  it("keeps local curation for an unproven global package identity", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "diffs",
        name: "Private Diffs",
        origin: "global",
        packageName: "@openclaw/diffs",
      }),
    );
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([{ ...hostedFeedDiffsEntry, featured: false }]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        featured: true,
        order: 10,
      }),
    ]);
  });

  it("does not identify a package-less private bundled plugin by hosted runtime id", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        packageName: null,
        description: "Private local workboard.",
      }),
    );
    mocks.officialCatalog.mockResolvedValue(
      hostedCatalog([
        {
          ...hostedImpostorEntry,
          title: "Hosted impostor",
          description: "Untrusted hosted copy.",
          icon: "https://cdn.example.test/impostor.png",
        },
      ]),
    );

    const catalog = await listManagedPlugins({ config: {}, env: {} });
    const resolvedIcon = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "workboard",
    });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "workboard",
        name: "Workboard",
        description: "Private local workboard.",
        featured: true,
        order: 10,
      }),
    ]);
    expect(resolvedIcon).toBeUndefined();
  });

  it("does not identify a package-less global plugin by hosted runtime id alone", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ origin: "global", packageName: null }));
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([hostedImpostorEntry]));

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "workboard",
        featured: true,
        order: 10,
      }),
    ]);
  });

  it("clears local curation when a known published plugin is omitted from a live feed", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "diffs",
        name: "Diffs",
        origin: "global",
        installRecord: { source: "npm", spec: "@openclaw/diffs" },
      }),
    );
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([]));

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "diffs",
        packageName: "@openclaw/diffs",
        featured: false,
        order: 10,
      }),
    ]);
  });

  it("preserves npm-only bundled curation outside the hosted producer identity", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "acpx",
        name: "ACP Runtime",
        origin: "global",
        packageName: "@openclaw/acpx",
        installRecord: { source: "npm", spec: "@openclaw/acpx" },
      }),
    );
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([]));

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "acpx",
        featured: true,
        order: 10,
      }),
    ]);
  });

  it("clears hosted-only curation using trusted official install provenance", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "new-tool",
        name: "New Tool",
        origin: "global",
        packageName: "@openclaw/new-tool",
        installRecord: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubChannel: "official",
          clawhubPackage: "@openclaw/new-tool",
        },
      }),
    );
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([]));

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "new-tool",
        packageName: "@openclaw/new-tool",
        featured: false,
        order: 10,
      }),
    ]);
  });

  it("accepts trusted official install provenance without discovered package metadata", async () => {
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        id: "new-tool",
        name: "New Tool",
        origin: "global",
        packageName: null,
        installRecord: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubChannel: "official",
          clawhubPackage: "@openclaw/new-tool",
        },
      }),
    );
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([]));

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: "new-tool",
        featured: false,
        order: 10,
      }),
    ]);
  });

  it.each([
    { mode: "one dual-source occurrence", expectedId: "bundled" },
    { mode: "split source occurrences", expectedId: "remote" },
    { mode: "repeated object occurrence", expectedId: "remote" },
    { mode: "cloned occurrence", expectedId: "remote" },
    { mode: "different source", expectedId: "remote" },
    { mode: "different ClawHub case", expectedId: "remote" },
  ])("preserves overlay identity for $mode", async ({ mode, expectedId }) => {
    const both = { clawhubSpec: "clawhub:@acme/shared", npmSpec: "@acme/shared" };
    const bundled = compositionEntry("bundled", both, { order: 41 });
    const hosted = compositionEntry("remote", both);
    let bundledEntries = [bundled];
    if (mode === "split source occurrences") {
      bundledEntries = [
        compositionEntry("bundled-clawhub", { clawhubSpec: both.clawhubSpec }),
        compositionEntry("bundled-npm", { npmSpec: both.npmSpec }),
      ];
    } else if (mode === "repeated object occurrence") {
      bundledEntries = [bundled, bundled];
    } else if (mode === "cloned occurrence") {
      bundledEntries = [bundled, { ...bundled }];
    } else if (mode === "different source") {
      hosted.openclaw.install = { clawhubSpec: both.clawhubSpec };
      bundled.openclaw.install = { npmSpec: both.npmSpec };
    } else if (mode === "different ClawHub case") {
      hosted.openclaw.install = { clawhubSpec: "clawhub:@acme/Shared" };
      bundled.openclaw.install = { clawhubSpec: both.clawhubSpec };
    }
    mocks.bundledEntries = bundledEntries;
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    mocks.officialCatalog.mockResolvedValue(hostedCatalog([hosted]));

    const catalog = await listManagedPlugins({ config: {}, env: {} });

    expect(catalog.plugins).toEqual([
      expect.objectContaining({
        id: expectedId,
        featured: true,
        order: expectedId === "bundled" ? 41 : 7,
      }),
    ]);
  });

  it.each([
    "one",
    "repeated object",
    "clone",
    "npm source only",
    "dual-source feed",
    "npm namesake",
  ])(
    "preserves installed identity and package suppression for %s hosted occurrence",
    async (mode) => {
      const hostedIcon = "https://cdn.example.test/hosted.png";
      mocks.metadata.mockReturnValue(
        metadataSnapshot({
          id: "installed",
          name: "Local",
          packageName: "@acme/installed",
        }),
      );
      mocks.bundledEntries = [
        {
          ...compositionEntry("catalog-runtime", {
            clawhubSpec: "clawhub:@acme/shared",
            npmSpec: "@acme/installed",
          }),
          name: "@acme/installed",
        },
      ];
      const hosted = {
        ...compositionEntry(
          "remote",
          mode === "npm source only" || mode === "npm namesake"
            ? { npmSpec: mode === "npm namesake" ? "@acme/shared" : "@acme/installed" }
            : { clawhubSpec: "clawhub:@acme/shared" },
        ),
        title: "Remote",
        icon: hostedIcon,
        ...(mode === "dual-source feed"
          ? {
              state: "available",
              publisher: { trust: "official" },
              install: {
                candidates: [
                  { sourceRef: "public-npm", package: "@acme/installed" },
                  { sourceRef: "public-clawhub", package: "@acme/shared" },
                ],
              },
            }
          : {}),
      };
      // The declared ClawHub counterpart suppresses duplicates without inventing npm identity.
      const entries =
        mode === "repeated object"
          ? [hosted, hosted]
          : mode === "clone"
            ? [hosted, { ...hosted }]
            : [hosted];
      mocks.officialCatalog.mockResolvedValue(hostedCatalog(entries));

      const catalog = await listManagedPlugins({ config: {}, env: {} });
      const icon = await resolveManagedPluginIconSource({
        config: {},
        env: {},
        pluginId: "installed",
      });
      const curated = mode === "one" || mode === "dual-source feed";

      expect(catalog.plugins).toEqual([
        ...(mode === "npm namesake"
          ? [
              expect.objectContaining({
                id: "remote",
                installed: false,
                packageName: "@acme/shared",
              }),
            ]
          : []),
        expect.objectContaining({
          id: "installed",
          installed: true,
          name: curated ? "Remote" : "Local",
          featured: curated,
        }),
      ]);
      expect(catalog.plugins.find((entry) => entry.id === "installed")?.hasIcon).toBeUndefined();
      expect(icon).toBeUndefined();
    },
  );

  it.each([
    { mode: "first hosted icon", firstIcon: "https://cdn.example.test/first.png" },
    { mode: "first missing icon", firstIcon: undefined },
    {
      mode: "normalized manifest fallback",
      firstIcon: undefined,
      fallbackIcon: "https://cdn.example.test/normalized.png",
    },
  ])("retains normalized first-record selection for $mode", async ({ firstIcon, fallbackIcon }) => {
    const first = metadataSnapshot({
      id: "Alias",
      name: "First",
      origin: "global",
      packageName: "@acme/first",
      installRecord: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "official",
        clawhubPackage: "@acme/first",
      },
    });
    const second = metadataSnapshot({
      id: "ALIAS",
      name: "Second",
      origin: "global",
      packageName: "@acme/second",
      installRecord: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "official",
        clawhubPackage: "@acme/second",
      },
    });
    const normalizedManifest = {
      ...first.plugins[0]!,
      id: "alias",
      icon: fallbackIcon,
    };
    mocks.metadata.mockReturnValue({
      ...first,
      index: {
        plugins: [...first.index.plugins, ...second.index.plugins],
        installRecords: { ...first.index.installRecords, ...second.index.installRecords },
      },
      plugins: [...first.plugins, ...second.plugins],
      byPluginId: new Map([
        ...first.byPluginId,
        ...second.byPluginId,
        ["alias", normalizedManifest],
      ]),
      normalizePluginId: (id: string) => id.trim().toLowerCase(),
    });
    const officialCatalog = {
      entries: [
        { ...compositionEntry("first", { clawhubSpec: "clawhub:@acme/first" }), icon: firstIcon },
        {
          ...compositionEntry("second", { clawhubSpec: "clawhub:@acme/second" }),
          icon: "https://cdn.example.test/second.png",
        },
      ],
    };
    const catalog = await listManagedPlugins({ config: {}, env: {}, officialCatalog });
    const icon = await resolveManagedPluginIconSource({
      config: {},
      env: {},
      pluginId: "ALIAS",
    });

    expect(catalog.plugins).toHaveLength(2);
    for (const plugin of catalog.plugins) {
      expect(plugin.hasIcon).toBeUndefined();
    }
    expect(icon).toBeUndefined();
  });

  it.each([undefined, "https://cdn.example.test/first.png"])(
    "resolves the first uninstalled duplicate catalog ID with icon %s",
    async (firstIcon) => {
      mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
      const officialCatalog = {
        entries: [
          { ...compositionEntry("duplicate"), icon: firstIcon },
          { ...compositionEntry("duplicate"), icon: "https://cdn.example.test/second.png" },
        ],
      };

      const catalog = await listManagedPlugins({ config: {}, env: {}, officialCatalog });
      const icon = await resolveManagedPluginIconSource({
        config: {},
        env: {},
        pluginId: "duplicate",
      });

      expect(catalog.plugins.map((plugin) => plugin.hasIcon)).toEqual([undefined, undefined]);
      expect(icon).toBeUndefined();
    },
  );

  it.each([
    {
      name: "unversioned ClawHub",
      install: { clawhubSpec: "clawhub:@acme/action" },
      source: "clawhub",
    },
    {
      name: "pinned ClawHub",
      install: { clawhubSpec: "clawhub:@acme/action@1.2.3" },
      source: "official",
    },
    { name: "npm", install: { npmSpec: "@acme/action@1.2.3" }, source: "official" },
    {
      name: "npm with unversioned ClawHub",
      install: { npmSpec: "@acme/action@1.2.3", clawhubSpec: "clawhub:@acme/action" },
      source: "official",
    },
    { name: "local", install: { localPath: "./plugin" }, source: "official" },
    { name: "malformed ClawHub", install: { clawhubSpec: "clawhub:" }, source: "official" },
    {
      name: "malformed npm selector",
      install: { npmSpec: "@acme/action@^1.2.3" },
      source: "official",
    },
    {
      name: "malformed npm selector with unversioned ClawHub",
      install: {
        npmSpec: "@acme/action@^1.2.3",
        clawhubSpec: "clawhub:@acme/action",
      },
      source: "official",
    },
    { name: "no install", install: {}, source: undefined },
    {
      name: "rejected state",
      install: { npmSpec: "@acme/action" },
      source: undefined,
      state: "rejected",
      publisher: { trust: "official" },
    },
    {
      name: "rejected publisher",
      install: { npmSpec: "@acme/action" },
      source: undefined,
      state: "available",
      publisher: { trust: "community" },
    },
    {
      name: "incomplete authority",
      install: { npmSpec: "@acme/action" },
      source: undefined,
      state: "available",
    },
  ])(
    "preserves the public install action for $name",
    async ({ install, source, state, publisher }) => {
      mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
      const entry = { ...compositionEntry("action", install), state, publisher };

      const catalog = await listManagedPlugins({
        config: {},
        env: {},
        officialCatalog: { entries: [entry] },
      });

      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.plugins[0]?.install).toEqual(
        source === "clawhub"
          ? { source: "clawhub", packageName: "@acme/action" }
          : source === "official"
            ? { source: "official", pluginId: "action" }
            : undefined,
      );
    },
  );
});
