const PLUGIN_MANIFEST_INSTALL_OWNER = Symbol.for("openclaw.pluginManifestInstallOwner");

type PluginManifestInstallOwner = { installOwner?: string; ambiguous?: true };

export function recordPluginManifestInstallOwner<T extends object>(
  record: T,
  installOwner: string | undefined,
  ambiguous = false,
): T {
  if (!installOwner && !ambiguous) {
    return record;
  }
  Object.defineProperty(record, PLUGIN_MANIFEST_INSTALL_OWNER, {
    configurable: false,
    enumerable: true,
    value: ambiguous ? { ambiguous: true } : { installOwner },
  });
  return record;
}

function readPluginManifestInstallOwner(record: object): PluginManifestInstallOwner | undefined {
  return (record as { [PLUGIN_MANIFEST_INSTALL_OWNER]?: PluginManifestInstallOwner })[
    PLUGIN_MANIFEST_INSTALL_OWNER
  ];
}

export function resolvePluginManifestInstallOwner(record: object): string | undefined {
  return readPluginManifestInstallOwner(record)?.installOwner;
}

export function isPluginManifestInstallOwnerAmbiguous(record: object): boolean {
  return readPluginManifestInstallOwner(record)?.ambiguous === true;
}
