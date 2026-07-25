export type RuntimeSidecarLoaderViolation = {
  line: number;
  specifier: string;
  sourcePath: string;
  reason: string;
};
export function collectTsdownEntrySources(
  config: Array<{ entry?: Record<string, string> }>,
): Set<string>;
export function findRuntimeSidecarLoaderViolations(
  content: string,
  importerPath: string,
  explicitEntrySources: Set<string>,
): RuntimeSidecarLoaderViolation[];
