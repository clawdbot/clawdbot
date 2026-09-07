// Control UI config module wires control ui chunking behavior.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, "../..");
// Fresh /new and /chat captures separate shared boot work from route-only work.
// The generator disables these groups so stale entries cannot feed back into it.
const controlUiBootModules = JSON.parse(
  fs.readFileSync(path.join(configDir, "control-ui-boot-modules.json"), "utf8"),
) as Record<"shared" | "new" | "chat", string[]>;

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

  if (moduleIdIncludesPackage(id, "zod") || moduleIdIncludesPackage(id, "json5")) {
    return "config-runtime";
  }

  if (moduleIdIncludesPackage(id, "libphonenumber-js")) {
    return "phone-runtime";
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
    ...(["shared", "new", "chat"] as const).map((route, index) => {
      const modules = new Set(controlUiBootModules[route]);
      return {
        name: `control-ui-boot-${route}`,
        test: (id: string) => modules.has(controlUiBootManifestKey(id)),
        // Shared dependencies must be assigned first, or a route group pulls
        // them (and therefore other routes) into its eagerly imported chunk.
        priority: 8 - index,
        includeDependenciesRecursively: true,
        // Chat's dense module graph needs a smaller target to stay within the
        // existing largest-JS budget; shared boot retains its request grouping.
        maxSize: (route === "chat" ? 1408 : 1536) * 1024,
      };
    }),
  ],
};
