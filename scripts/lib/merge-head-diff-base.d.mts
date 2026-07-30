/** Resolve the git base ref to use when diffing a merge head. */
export function resolveMergeHeadDiffBase({
  base,
  head,
  cwd,
  maxBuffer,
  preferFirstParent,
}: {
  base: unknown;
  head?: string | undefined;
  cwd?: string | undefined;
  maxBuffer?: number | undefined;
  preferFirstParent?: boolean | undefined;
}): unknown;
export function parseArgs(argv: unknown): {
  base: string;
  head: string;
  preferFirstParent: boolean;
};
