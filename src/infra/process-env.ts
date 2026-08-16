/** Read one environment value using the same Windows key precedence as child_process. */
export function resolveEnvironmentValue(
  env: NodeJS.ProcessEnv | undefined,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!env) {
    return undefined;
  }
  if (platform !== "win32") {
    return env[name] ?? (name === "PATH" ? env.Path : undefined);
  }
  const normalizedName = name.toUpperCase();
  const key = Object.keys(env)
    .toSorted()
    .find((candidate) => candidate.toUpperCase() === normalizedName);
  return key === undefined ? undefined : env[key];
}

/** Merge child environments while preserving Node's platform-specific key semantics. */
export function mergeProcessEnv(
  sources: ReadonlyArray<NodeJS.ProcessEnv | undefined>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const source of sources) {
    if (!source) {
      continue;
    }
    const keys = Object.keys(source);
    // Node keeps the lexicographically first case-insensitive duplicate from each
    // Windows env object. Later source objects still own override precedence.
    const sourceKeys = new Set<string>();
    for (const key of platform === "win32" ? keys.toSorted() : keys) {
      if (platform === "win32") {
        const normalizedKey = key.toUpperCase();
        if (sourceKeys.has(normalizedKey)) {
          continue;
        }
        sourceKeys.add(normalizedKey);
        for (const previousKey of Object.keys(merged)) {
          if (previousKey.toUpperCase() === normalizedKey) {
            delete merged[previousKey];
          }
        }
      }
      const value = source[key];
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
}
