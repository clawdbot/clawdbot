export type ChangedPathSurface =
  | "docs"
  | "source"
  | "package"
  | "ui"
  | "extension"
  | "app"
  | "rootTest"
  | "testFixture"
  | "rootTooling"
  | "rootGlobal"
  | "legacyRootAsset"
  | "unknown";

export type ChangedPathFacts = {
  path: string;
  surface: ChangedPathSurface;
  isChangedLaneTest: boolean;
  isTestOnly: boolean;
  isNativeOnly: boolean;
};

export function normalizeChangedPath(inputPath: unknown): string;
export function getChangedPathFacts(inputPath: unknown): ChangedPathFacts;
