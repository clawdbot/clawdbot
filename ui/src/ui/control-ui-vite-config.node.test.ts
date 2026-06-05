// Control UI tests cover control ui vite config behavior.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  controlUiBrowserOnlySharedModuleAliases,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../../vite.config.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
type ResolveIdHandler = (
  this: never,
  source: string,
  importer: string | undefined,
  options: { custom: Record<string, never>; isEntry: boolean; ssr: boolean },
) => unknown;

function findStringAlias(key: string) {
  return resolveTsconfigPathAliasesForVite().find((alias) => alias.find === key);
}

describe("Control UI Vite config", () => {
  it("resolves root tsconfig package aliases for source imports", () => {
    expect(findStringAlias("@openclaw/net-policy/ip")?.replacement).toBe(
      path.join(repoRoot, "packages/net-policy/src/ip.ts"),
    );
  });

  it("resolves Control UI dev-server source aliases for internal packages", () => {
    const aliases = resolveSourcePackageAliasesForVite();
    expect(
      aliases.find((alias) => alias.find === "@openclaw/normalization-core/string-coerce"),
    )?.toEqual({
      find: "@openclaw/normalization-core/string-coerce",
      replacement: path.join(repoRoot, "packages/normalization-core/src/string-coerce.ts"),
    });
  });

  it("keeps specific tsconfig aliases ahead of broad package aliases", () => {
    const aliases = resolveTsconfigPathAliasesForVite();
    const netPolicyIpIndex = aliases.findIndex((alias) => alias.find === "@openclaw/net-policy/ip");
    const netPolicyPackageIndex = aliases.findIndex(
      (alias) => alias.find === "@openclaw/net-policy",
    );
    const netPolicyWildcardIndex = aliases.findIndex(
      (alias) =>
        alias.find instanceof RegExp && alias.replacement.includes("packages/net-policy/src/$1"),
    );
    const broadOpenClawWildcardIndex = aliases.findIndex(
      (alias) => alias.find instanceof RegExp && alias.replacement.includes("extensions/$1"),
    );

    expect(netPolicyIpIndex).toBeGreaterThanOrEqual(0);
    expect(netPolicyWildcardIndex).toBeGreaterThanOrEqual(0);
    expect(netPolicyPackageIndex).toBeGreaterThanOrEqual(0);
    expect(broadOpenClawWildcardIndex).toBeGreaterThanOrEqual(0);
    expect(netPolicyIpIndex).toBeLessThan(netPolicyPackageIndex);
    expect(netPolicyWildcardIndex).toBeLessThan(broadOpenClawWildcardIndex);
  });

  it("uses a browser-safe redactor for shared tool display imports", async () => {
    const plugin = controlUiBrowserOnlySharedModuleAliases();
    const resolveIdHook = plugin.resolveId;
    const resolveIdHandler = (
      typeof resolveIdHook === "function" ? resolveIdHook : resolveIdHook?.handler
    ) as ResolveIdHandler | undefined;
    if (!resolveIdHandler) {
      throw new Error("Expected browser-only shared module alias plugin to expose resolveId");
    }

    for (const importerSuffix of ["", "?browserv=123"]) {
      const resolved = await resolveIdHandler.call(
        {} as never,
        "../logging/redact.js",
        `${path.join(repoRoot, "src/agents/tool-display-common.ts")}${importerSuffix}`,
        { custom: {}, isEntry: false, ssr: false },
      );

      expect(resolved).toBe(path.join(repoRoot, "ui/src/ui/browser-redact.ts"));
    }
  });
});
