import type { PluginManifestRecord } from "./manifest-registry.js";

export function configSnapshot(config: Record<string, unknown> = {}) {
  return {
    snapshot: {
      valid: true,
      parsed: {},
      path: "/tmp/openclaw.json",
      sourceConfig: config,
      hash: "base-hash",
    },
    writeOptions: {
      expectedConfigPath: "/tmp/openclaw.json",
      includeFileHashesForWrite: { "/tmp/plugins.json": "include-hash" },
      includeFileTargetsForWrite: { "/tmp/plugins.json": "/tmp/plugins.json" },
    },
  };
}

export function metadataSnapshot(params: {
  enabled: boolean;
  id?: string;
  name?: string;
  origin?: "bundled" | "global";
  installRecord?: Record<string, unknown>;
  icon?: string;
}) {
  const id = params.id ?? "workboard";
  const origin = params.origin ?? "bundled";
  const installRecord =
    params.installRecord ??
    (origin === "global" ? { source: "path", installPath: `/tmp/${id}` } : undefined);
  const manifest: PluginManifestRecord = {
    id,
    name: params.name ?? "Workboard",
    description: "Coordinate agent work in a shared board.",
    catalog: { featured: true, order: 10 },
    ...(params.icon ? { icon: params.icon } : {}),
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin,
    rootDir: `/tmp/${id}`,
    source: `/tmp/${id}/index.ts`,
    manifestPath: `/tmp/${id}/openclaw.plugin.json`,
  };
  return {
    index: {
      plugins: [
        {
          pluginId: id,
          ...(origin === "global" ? { installOwner: id } : {}),
          packageName: `@openclaw/${id}`,
          origin,
          enabled: params.enabled,
          rootDir: `/tmp/${id}`,
        },
      ],
      installRecords: installRecord ? { [id]: installRecord } : {},
    },
    byPluginId: new Map([[id, manifest]]),
    plugins: [manifest],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

export function emptyMetadataSnapshot() {
  return {
    index: { plugins: [], installRecords: {} },
    byPluginId: new Map(),
    plugins: [],
    diagnostics: [],
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

export const hostedDiffsEntry = {
  name: "@openclaw/diffs",
  version: "2.0.0",
  description: "Hosted description",
  openclaw: {
    plugin: { id: "diffs", label: "Hosted Diffs" },
    install: { clawhubSpec: "clawhub:@openclaw/diffs", defaultChoice: "clawhub" },
  },
};

// Mirrors the ClawHub feed: package identity is remote, while runtime metadata stays local.
export const hostedFeedDiffsEntry = {
  id: "@openclaw/diffs",
  title: "Diffs",
  state: "available",
  featured: true,
  publisher: { id: "openclaw", trust: "official" },
  install: {
    candidates: [
      {
        sourceRef: "public-clawhub",
        package: "@openclaw/diffs",
        version: "2026.6.11",
        integrity: `sha256:${"a".repeat(64)}`,
      },
    ],
  },
};
