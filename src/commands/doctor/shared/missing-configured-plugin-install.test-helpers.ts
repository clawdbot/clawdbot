const DEFAULT_RESOLVED_AT = "2026-05-01T00:00:00.000Z";

export function officialPluginEntry(params: {
  id: string;
  npmSpec: string;
  label?: string;
  manifest?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
}) {
  const label = params.label ?? params.id;
  return {
    id: params.id,
    label,
    install: {
      npmSpec: params.npmSpec,
      defaultChoice: "npm",
    },
    ...(params.manifest
      ? {
          openclaw: {
            plugin: { id: params.id, label },
            ...params.manifest,
          },
        }
      : {}),
    ...params.overrides,
  };
}

export function officialWebSearchPluginEntry(params: {
  id: string;
  npmSpec: string;
  envVar: string;
  label?: string;
  providerLabel?: string;
  credentialPath?: string;
  includeManifestInstall?: boolean;
}) {
  const label = params.label ?? params.id;
  const providerLabel = params.providerLabel ?? label;
  const install = { npmSpec: params.npmSpec, defaultChoice: "npm" };
  return officialPluginEntry({
    id: params.id,
    npmSpec: params.npmSpec,
    label,
    manifest: {
      webSearchProviders: [
        {
          id: params.id,
          label: providerLabel,
          hint: providerLabel,
          envVars: [params.envVar],
          placeholder: `${params.id}-key`,
          signupUrl: `https://example.test/${params.id}`,
          ...(params.credentialPath ? { credentialPath: params.credentialPath } : {}),
        },
      ],
      ...(params.includeManifestInstall ? { install } : {}),
    },
  });
}

export function channelPluginEntry(params: {
  id: string;
  npmSpec: string;
  label?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
}) {
  return {
    id: params.id,
    pluginId: params.id,
    meta: { label: params.label ?? params.id },
    install: {
      npmSpec: params.npmSpec,
      defaultChoice: "npm",
    },
    ...(params.trustedSourceLinkedOfficialInstall === undefined
      ? {}
      : { trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall }),
  };
}

export function installedRecords(
  pluginId: string,
  overrides: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  return {
    [pluginId]: {
      source: "npm",
      ...overrides,
    },
  };
}

export function successfulInstall(params: {
  pluginId: string;
  npmSpec: string;
  version?: string;
  targetDir?: string;
  resolution?: Record<string, unknown>;
}) {
  const version = params.version ?? "2026.6.8";
  return {
    ok: true as const,
    pluginId: params.pluginId,
    targetDir: params.targetDir ?? `/tmp/openclaw-plugins/${params.pluginId}`,
    version,
    npmResolution: {
      name: params.npmSpec,
      version,
      resolvedSpec: `${params.npmSpec}@${version}`,
      integrity: `sha512-${params.pluginId}`,
      resolvedAt: DEFAULT_RESOLVED_AT,
      ...params.resolution,
    },
  };
}

export function successfulUpdate(
  pluginId: string,
  installs: Record<string, Record<string, unknown>>,
) {
  return {
    changed: true,
    config: { plugins: { installs } },
    outcomes: [
      {
        pluginId,
        status: "updated",
        message: `Updated ${pluginId}.`,
      },
    ],
  };
}

export function brokenPluginSnapshot(
  pluginId: string,
  source: string,
  expectedEntry = "./dist/index.js",
) {
  return {
    plugins: [],
    diagnostics: [
      {
        level: "error",
        pluginId,
        source,
        message: `installed plugin package requires compiled runtime output for TypeScript entry index.ts: expected ${expectedEntry}.`,
      },
    ],
  };
}
