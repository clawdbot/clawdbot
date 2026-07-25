/** List bundled extension ids available in git or the local extensions directory. */
export function listAvailableExtensionIds(): string[];
/** Map changed paths to bundled extension ids, ignoring unknown extension-like paths. */
export function detectChangedExtensionIds(changedPaths: string[]): string[];
/** List changed bundled extension ids between a resolved base and head revision. */
export function listChangedExtensionIds(params?: {
  base?: string;
  cwd?: string;
  head?: string;
  unavailableBaseBehavior?: "all" | "empty" | "error";
}): string[];
