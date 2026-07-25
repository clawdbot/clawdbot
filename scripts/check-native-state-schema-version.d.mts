export interface NativeStateSchemaSources {
  swiftSource: string;
  typescriptSource: string;
}

export function compareNativeStateSchemaVersions(sources: NativeStateSchemaSources): number;
export function checkNativeStateSchemaVersion(
  readFileSync?: typeof import("node:fs").readFileSync,
): number;
