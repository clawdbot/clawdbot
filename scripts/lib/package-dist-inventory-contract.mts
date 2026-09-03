import { LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH } from "./package-lifecycle-marker.mjs";

export const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";

const UNINVENTORIED_PACKAGE_DIST_PATHS = new Set([
  PACKAGE_DIST_INVENTORY_RELATIVE_PATH,
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
]);

export function comparePackageDistInventory(params: {
  files: Iterable<string>;
  inventory: Iterable<string>;
}): {
  packagedFilesMissingFromInventory: string[];
  inventoryEntriesMissingFromPackage: string[];
} {
  const files = new Set(
    [...params.files]
      .map((entry) => entry.replace(/\\/gu, "/"))
      .filter((entry) => entry.startsWith("dist/")),
  );
  const inventory = new Set([...params.inventory].map((entry) => entry.replace(/\\/gu, "/")));

  return {
    packagedFilesMissingFromInventory: [...files]
      .filter((entry) => !UNINVENTORIED_PACKAGE_DIST_PATHS.has(entry) && !inventory.has(entry))
      .toSorted(),
    inventoryEntriesMissingFromPackage: [...inventory]
      .filter((entry) => !files.has(entry))
      .toSorted(),
  };
}
