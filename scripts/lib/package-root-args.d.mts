/** Parse `--package-root` or an environment fallback into an absolute package root. */
export function parsePackageRootArg(
  argv: unknown,
  envName: unknown,
): {
  packageRoot: string;
};
