// Reads package.json metadata needed by install and update flows.
import path from "node:path";
import { normalizeNullableString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { tryReadJson } from "./json-files.js";

type PackageJson = {
  name?: unknown;
  packageManager?: unknown;
  version?: unknown;
};

/** Reads package.json as a loose object, returning null for missing or invalid manifests. */
export async function readPackageJson(root: string): Promise<PackageJson | null> {
  const parsed = await tryReadJson<unknown>(path.join(root, "package.json"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as PackageJson)
    : null;
}

/** Reads and trims the package version string, returning null for blank or non-string values. */
export async function readPackageVersion(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.version);
}

/** Reads and trims the package name string, returning null for blank or non-string values. */
export async function readPackageName(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.name);
}

/** Reads and trims the packageManager spec, returning null for blank or non-string values. */
export async function readPackageManagerSpec(root: string): Promise<string | null> {
  return normalizeString((await readPackageJson(root))?.packageManager);
}
