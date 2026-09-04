import type { UserConfig } from "tsdown";

/** Keep runtime chunking independent from declaration graph construction. */
export function splitTsdownPackageConfig(
  config: UserConfig,
  emitDeclarations: boolean,
): UserConfig[] {
  const runtimeConfig = { ...config, dts: false } satisfies UserConfig;
  if (!emitDeclarations) {
    return [runtimeConfig];
  }
  return [runtimeConfig, { ...config, dts: { emitDtsOnly: true } }];
}
