// Control UI config module wires control ui chunking behavior.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");
// Measured module set the default boot flow (app shell + sidebar + chat route)
// loads through dynamic imports. Regenerate with `pnpm ui:boot-manifest:gen`
// after a build; stale entries degrade gracefully back to automatic chunking.
const controlUiBootModules: ReadonlySet<string> = new Set(
  JSON.parse(
    fs.readFileSync(path.join(configDir, "control-ui-boot-modules.json"), "utf8"),
  ) as string[],
);

function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/");
}

export function controlUiBootManifestKey(id: string): string {
  // Canonical manifest key: vendor modules key from their innermost
  // node_modules entry so pnpm virtual-store paths match; first-party modules
  // key repo-relative.
  const stripped = id.replace(/[?#].*$/u, "");
  const normalized = normalizeModuleId(stripped);
  const vendorIndex = normalized.lastIndexOf("/node_modules/");
  if (vendorIndex !== -1) {
    return `node_modules/${normalized.slice(vendorIndex + "/node_modules/".length)}`;
  }
  return normalizeModuleId(path.relative(repoRoot, stripped));
}

function moduleIdIncludesPackage(id: string, packageName: string): boolean {
  const normalized = normalizeModuleId(id);
  return (
    normalized.includes(`/node_modules/${packageName}/`) ||
    normalized.includes(`/openclaw-pnpm-node-modules/${packageName}/`)
  );
}

export function controlUiStableChunkName(id: string): string | undefined {
  const normalized = normalizeModuleId(id);

  if (normalized.endsWith("/ui/src/lib/gateway-methods.ts")) {
    return "gateway-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "lit") ||
    moduleIdIncludesPackage(id, "lit-html") ||
    moduleIdIncludesPackage(id, "@lit/reactive-element")
  ) {
    return "lit-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "highlight.js") ||
    moduleIdIncludesPackage(id, "markdown-it") ||
    moduleIdIncludesPackage(id, "markdown-it-task-lists") ||
    moduleIdIncludesPackage(id, "dompurify") ||
    moduleIdIncludesPackage(id, "entities") ||
    moduleIdIncludesPackage(id, "linkify-it") ||
    moduleIdIncludesPackage(id, "mdurl") ||
    moduleIdIncludesPackage(id, "punycode.js") ||
    moduleIdIncludesPackage(id, "uc.micro")
  ) {
    return "markdown-runtime";
  }

  if (
    moduleIdIncludesPackage(id, "zod") ||
    moduleIdIncludesPackage(id, "json5") ||
    moduleIdIncludesPackage(id, "libphonenumber-js")
  ) {
    return "config-runtime";
  }

  // @noble/hashes stays out of this startup chunk deliberately: it is only
  // dynamically imported as the insecure-context fallback digest provider.
  if (moduleIdIncludesPackage(id, "@noble/ed25519") || moduleIdIncludesPackage(id, "ipaddr.js")) {
    return "gateway-runtime";
  }

  return undefined;
}

export const controlUiCodeSplitting = {
  includeDependenciesRecursively: false,
  groups: [
    {
      name: (id: string) => controlUiStableChunkName(id) ?? null,
      test: (id: string) => controlUiStableChunkName(id) !== undefined,
      priority: 20,
    },
    {
      name: (id: string) =>
        normalizeModuleId(id).includes("/ui/src/") ? "control-ui-core" : "control-ui-foundation",
      tags: ["$initial"] as ["$initial"],
      priority: 10,
      // 640 KiB keeps the startup graph together; the previous 576 KiB boundary
      // split it into two extra requests and added roughly 1 KiB of gzip.
      maxSize: 640 * 1024,
    },
    {
      // Boot-path consolidation: the lazily-loaded modules the default boot
      // flow always fetches (~124 automatic chunks without this group) merge
      // into a handful of chunks so the gateway's HTTP/1.1 6-connection
      // transport pays ~7 instead of ~24 serialized round-trips on high-latency
      // links. Byte cost is ~zero: every captured module is fetched during boot
      // either way. Recursive dependency inclusion is required for correctness
      // here — merging without it emitted chunks whose execution order broke at
      // startup ("TypeError: X is not a function" during application start).
      name: "control-ui-boot",
      test: (id: string) => controlUiBootModules.has(controlUiBootManifestKey(id)),
      priority: 8,
      includeDependenciesRecursively: true,
      // Larger ceiling than the startup groups: this sizes pre-minification
      // module bytes, and ~1.5 MiB keeps the largest emitted chunk near
      // ~190 KiB gzip, inside the 215 KiB largest-JS budget.
      maxSize: 1536 * 1024,
    },
  ],
};
