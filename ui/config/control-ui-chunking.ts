// Control UI config module wires control ui chunking behavior.
function normalizeModuleId(id: string): string {
  return id.replace(/\\/g, "/");
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

  // These entry-and-route helpers must stay together; separate shared chunks
  // turn small route-graph changes into extra startup preload requests.
  if (
    normalized.endsWith("/ui/src/components/config-form.shared.ts") ||
    normalized.endsWith("/ui/src/lib/clipboard.ts") ||
    normalized.endsWith("/ui/src/build-info-normalizers.ts") ||
    normalized.endsWith("/ui/src/build-info.ts")
  ) {
    return "control-ui-shared";
  }

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

  if (
    moduleIdIncludesPackage(id, "@noble/ed25519") ||
    moduleIdIncludesPackage(id, "@noble/hashes") ||
    moduleIdIncludesPackage(id, "ipaddr.js")
  ) {
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
      // 448 KiB packs the core graph into fewer chunks; the previous 400 KiB
      // boundary split one core chunk in two, costing ~1.4 KiB startup gzip.
      maxSize: 448 * 1024,
    },
  ],
};
