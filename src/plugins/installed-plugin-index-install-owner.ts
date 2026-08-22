type InstalledPluginIndexInstallOwner = { installOwner?: string; ambiguous?: true };
type InstalledPluginIndexRecordWithOwner = {
  installOwner?: string;
  installOwnerAmbiguous?: true;
};

export function recordInstalledPluginIndexInstallOwner<T extends object>(
  record: T,
  installOwner: string | undefined,
  ambiguous = false,
): T {
  if (!installOwner && !ambiguous) {
    return record;
  }
  const ownedRecord = record as T & InstalledPluginIndexRecordWithOwner;
  if (ambiguous) {
    delete ownedRecord.installOwner;
    ownedRecord.installOwnerAmbiguous = true;
  } else {
    ownedRecord.installOwner = installOwner;
    delete ownedRecord.installOwnerAmbiguous;
  }
  return record;
}

function readInstalledPluginIndexInstallOwner(
  record: object,
): InstalledPluginIndexInstallOwner | undefined {
  const ownedRecord = record as InstalledPluginIndexRecordWithOwner;
  return ownedRecord.installOwnerAmbiguous
    ? { ambiguous: true }
    : ownedRecord.installOwner
      ? { installOwner: ownedRecord.installOwner }
      : undefined;
}

export function resolveInstalledPluginIndexInstallOwner(record: object): string | undefined {
  return readInstalledPluginIndexInstallOwner(record)?.installOwner;
}

export function isInstalledPluginIndexInstallOwnerAmbiguous(record: object): boolean {
  return readInstalledPluginIndexInstallOwner(record)?.ambiguous === true;
}
