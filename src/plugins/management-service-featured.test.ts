import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { clearManagedPluginOfficialCatalogCache, listManagedPlugins, resolveManagedPluginIconUrl } =
  await import("./management-service.js");

function metadataSnapshot(params: {
  id?: string;
  name?: string;
  origin?: "bundled" | "global";
  packageName?: string | null;
  installRecord?: Record<string, unknown>;
  featured?: boolean;
  description?: string;
  icon?: string;
}) {
  const id = params.id ?? "workboard";
  const packageName =
    params.packageName === null ? undefined : (params.packageName ?? `@openclaw/${id}`);
  const manifest = {
    id,
    name: params.name ?? "Workboard",
    description: params.description ?? "Coordinate agent work in a shared board.",
    catalog: { featured: params.featured ?? true, order: 10 },
    ...(params.icon ? { icon: params.icon } : {}),
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: params.origin ?? "bundled",
    rootDir: `/tmp/${id}`,
    source: `/tmp/${id}/index.ts`,
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
  };
  return {
    index: {
      plugins: [
        {
          pluginId: id,
          ...(packageName ? { packageName } : {}),
          origin: params.origin ?? "bundled",
          enabled: true,
        },
      ],
      installRecords: params.installRecord ? { [id]: params.installRecord } : {},
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
    const resolved = await resolveManagedPluginIconUrl({
      config: {},
      env: {},
      pluginId: "@expediagroup/expedia-openclaw",
      officialCatalog,
    });

    expect(catalog.plugins[0]).toMatchObject({
      id: "@expediagroup/expedia-openclaw",
      name: "Expedia Travel",
      description: "Search flights, stays, and travel options.",
      featured: true,
      order: 10,
      hasIcon: true,
    });
    expect(resolved).toBe(icon);
  });

  beforeEach(() => {
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
    { id: "open-prose", name: "OpenProse", packageName: "@openclaw/open-prose" },
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
        icon: "https://cdn.example.test/firecrawl-bundled.png",
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
    const resolvedIcon = await resolveManagedPluginIconUrl({
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
        hasIcon: true,
      }),
    ]);
    expect(resolvedIcon).toBe(hostedIcon);
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
    const localIcon = "https://cdn.example.test/private-workboard.png";
    mocks.metadata.mockReturnValue(
      metadataSnapshot({
        packageName: null,
        description: "Private local workboard.",
        icon: localIcon,
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
    const resolvedIcon = await resolveManagedPluginIconUrl({
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
    expect(resolvedIcon).toBe(localIcon);
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
});
