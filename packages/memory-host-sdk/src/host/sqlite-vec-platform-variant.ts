import { createRequire } from "node:module";

type PlatformVariant = { readonly pkg: string; readonly file: string };

const PLATFORM_VARIANTS: Readonly<Record<string, PlatformVariant | undefined>> = {
  "linux-x64": { pkg: "sqlite-vec-linux-x64", file: "vec0.so" },
  "linux-arm64": { pkg: "sqlite-vec-linux-arm64", file: "vec0.so" },
  "darwin-x64": { pkg: "sqlite-vec-darwin-x64", file: "vec0.dylib" },
  "darwin-arm64": { pkg: "sqlite-vec-darwin-arm64", file: "vec0.dylib" },
  "win32-x64": { pkg: "sqlite-vec-windows-x64", file: "vec0.dll" },
};

export function resolveSqliteVecPlatformVariant():
  | { pkg: string; extensionPath: string }
  | undefined {
  const entry = PLATFORM_VARIANTS[`${process.platform}-${process.arch}`];
  if (!entry) {
    return undefined;
  }
  try {
    const require_ = createRequire(import.meta.url);
    const extensionPath = require_.resolve(`${entry.pkg}/${entry.file}`);
    return { pkg: entry.pkg, extensionPath };
  } catch {
    return undefined;
  }
}
