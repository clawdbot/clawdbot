// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  controlUiBrowserOnlySharedModuleAliases,
  createControlUiPrecompressedAssetVariants,
  resolveControlUiBuildInfo,
  resolveExternalPackageAliasesForVite,
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
  it("emits Brotli and gzip variants only for bundled compressible assets", () => {
    const source = "console.log('precompressed');\n".repeat(200);
    const variants = createControlUiPrecompressedAssetVariants("assets/app-AbCd1234.js", source);

    expect(variants.map((variant) => variant.fileName)).toEqual([
      "assets/app-AbCd1234.js.br",
      "assets/app-AbCd1234.js.gz",
    ]);
    expect(brotliDecompressSync(variants[0]?.source ?? Buffer.alloc(0)).toString()).toBe(source);
    expect(gunzipSync(variants[1]?.source ?? Buffer.alloc(0)).toString()).toBe(source);
    expect(createControlUiPrecompressedAssetVariants("index.html", source)).toEqual([]);
    expect(createControlUiPrecompressedAssetVariants("assets/logo.png", source)).toEqual([]);
    expect(createControlUiPrecompressedAssetVariants("assets/app.js.map", source)).toEqual([]);
  });

  it("embeds one canonical artifact identity from explicit build inputs", () => {
    const readGitCommit = vi.fn(() => "f".repeat(40));
    const readGitCommitTimestamp = vi.fn(() => "2026-07-10T10:11:12.000Z");
    expect(
      resolveControlUiBuildInfo({
        env: {
          GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
          OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56Z",
        },
        readGitCommit,
        readGitCommitTimestamp,
        readGitBranch: () => null,
        readGitDirty: () => null,
        readPackageVersion: () => "2026.7.10",
      }),
    ).toEqual({
      version: "2026.7.10",
      commit: "0123456789abcdef0123456789abcdef01234567",
      commitAt: "2026-07-10T10:11:12.000Z",
      builtAt: "2026-07-10T12:34:56.000Z",
      branch: null,
      dirty: null,
      buildId: "2026.7.10-0123456789ab-2026-07-10T12-34-56.000Z",
    });
    expect(readGitCommit).not.toHaveBeenCalled();
    expect(readGitCommitTimestamp).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef01234567");
  });

  it("falls back to Git and the current UTC time only when inputs are absent", () => {
    expect(
      resolveControlUiBuildInfo({
        env: {},
        now: () => new Date("2026-07-10T13:14:15.000Z"),
        readGitCommit: () => "a".repeat(40),
        readGitCommitTimestamp: () => null,
        readGitBranch: () => null,
        readGitDirty: () => null,
        readPackageVersion: () => null,
      }),
    ).toEqual({
      version: null,
      commit: "a".repeat(40),
      commitAt: null,
      builtAt: "2026-07-10T13:14:15.000Z",
      branch: null,
      dirty: null,
      buildId: "aaaaaaaaaaaa-2026-07-10T13-14-15.000Z",
    });
  });

  it("uses checked-out Git instead of unverified GitHub workflow context", () => {
    const readGitCommit = vi.fn(() => "c".repeat(40));
    expect(
      resolveControlUiBuildInfo({
        env: { GITHUB_SHA: "b".repeat(40) },
        now: () => new Date("2026-07-10T13:14:15.000Z"),
        readGitCommit,
        readPackageVersion: () => null,
      }).commit,
    ).toBe("c".repeat(40));
    expect(readGitCommit).toHaveBeenCalledOnce();
    expect(
      resolveControlUiBuildInfo({
        env: { GITHUB_SHA: "b".repeat(40) },
        now: () => new Date("2026-07-10T13:14:15.000Z"),
        readGitCommit: () => null,
        readPackageVersion: () => null,
      }).commit,
    ).toBe("b".repeat(40));
    expect(() =>
      resolveControlUiBuildInfo({
        env: { GITHUB_SHA: "bad" },
        readGitCommit: () => null,
        readPackageVersion: () => null,
      }),
    ).toThrow("GITHUB_SHA must be a full 40-character hexadecimal SHA");
  });

  it("uses explicit commit aliases before reading Git", () => {
    const readGitCommit = vi.fn(() => "c".repeat(40));
    expect(
      resolveControlUiBuildInfo({
        env: { GIT_SHA: "A".repeat(40), GITHUB_SHA: "b".repeat(40) },
        now: () => new Date("2026-07-10T13:14:15.000Z"),
        readGitCommit,
        readPackageVersion: () => null,
      }).commit,
    ).toBe("a".repeat(40));
    expect(readGitCommit).not.toHaveBeenCalled();
  });

  it("prefers GIT_BRANCH over GitHub and checked-out Git branch identity", () => {
    const readGitBranch = vi.fn(() => "git-fallback");
    expect(
      resolveControlUiBuildInfo({
        env: {
          GIT_BRANCH: " feature/from-env ",
          GITHUB_REF_NAME: "feature/from-github",
          GITHUB_REF_TYPE: "branch",
        },
        readGitBranch,
        readGitCommit: () => null,
        readGitDirty: () => null,
        readPackageVersion: () => null,
      }).branch,
    ).toBe("feature/from-env");
    expect(readGitBranch).not.toHaveBeenCalled();
  });

  it("uses GITHUB_REF_NAME only for branch refs", () => {
    const readGitBranch = vi.fn(() => "git-fallback");
    expect(
      resolveControlUiBuildInfo({
        env: { GITHUB_REF_NAME: "feature/github", GITHUB_REF_TYPE: "branch" },
        readGitBranch,
        readGitCommit: () => null,
        readGitDirty: () => null,
        readPackageVersion: () => null,
      }).branch,
    ).toBe("feature/github");
    expect(readGitBranch).not.toHaveBeenCalled();

    expect(
      resolveControlUiBuildInfo({
        env: { GITHUB_REF_NAME: "v2026.7.10", GITHUB_REF_TYPE: "tag" },
        readGitBranch,
        readGitCommit: () => null,
        readGitDirty: () => null,
        readPackageVersion: () => null,
      }).branch,
    ).toBe("git-fallback");
  });

  it("falls back to checked-out Git and treats detached HEAD as unknown", () => {
    expect(
      resolveControlUiBuildInfo({
        env: {},
        readGitBranch: () => "feature/from-git",
        readGitCommit: () => null,
        readGitDirty: () => null,
        readPackageVersion: () => null,
      }).branch,
    ).toBe("feature/from-git");
    expect(
      resolveControlUiBuildInfo({
        env: {},
        readGitBranch: () => "HEAD",
        readGitCommit: () => null,
        readGitDirty: () => null,
        readPackageVersion: () => null,
      }).branch,
    ).toBeNull();
  });

  it("captures clean, dirty, and unavailable Git worktree state", () => {
    const resolveDirty = (readGitDirty: () => boolean | null) =>
      resolveControlUiBuildInfo({
        env: {},
        readGitBranch: () => null,
        readGitCommit: () => null,
        readGitDirty,
        readPackageVersion: () => null,
      }).dirty;

    expect(resolveDirty(() => true)).toBe(true);
    expect(resolveDirty(() => false)).toBe(false);
    expect(resolveDirty(() => null)).toBeNull();
  });

  it("does not let a generic release selector replace the artifact build identity", () => {
    expect(
      resolveControlUiBuildInfo({
        env: {
          OPENCLAW_VERSION: "latest",
          OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T13:14:15.000Z",
        },
        readGitCommit: () => "a".repeat(40),
        readPackageVersion: () => "2026.7.10",
      }).buildId,
    ).toBe("2026.7.10-aaaaaaaaaaaa-2026-07-10T13-14-15.000Z");
  });

  it("ignores a whitespace-only explicit build id", () => {
    expect(
      resolveControlUiBuildInfo({
        env: {
          OPENCLAW_CONTROL_UI_BUILD_ID: "   ",
          OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T13:14:15.000Z",
        },
        readGitCommit: () => "a".repeat(40),
        readPackageVersion: () => "2026.7.10",
      }).buildId,
    ).toBe("2026.7.10-aaaaaaaaaaaa-2026-07-10T13-14-15.000Z");
  });

  it("fails closed for nonempty invalid explicit build inputs", () => {
    const readGitCommit = vi.fn(() => "a".repeat(40));
    expect(() =>
      resolveControlUiBuildInfo({
        env: { GIT_COMMIT: "deadbeef" },
        readGitCommit,
        readPackageVersion: () => "2026.7.10",
      }),
    ).toThrow("GIT_COMMIT must be a full 40-character hexadecimal SHA");
    expect(readGitCommit).not.toHaveBeenCalled();

    expect(() =>
      resolveControlUiBuildInfo({
        env: { OPENCLAW_BUILD_TIMESTAMP: "2026-07-10 12:34:56" },
        readGitCommit: () => "a".repeat(40),
        readPackageVersion: () => "2026.7.10",
      }),
    ).toThrow("OPENCLAW_BUILD_TIMESTAMP must be a valid UTC ISO-8601 timestamp ending in Z");
  });

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
    expect(
      aliases.find((alias) => alias.find === "@openclaw/normalization-core/phone-presentation"),
    )?.toEqual({
      find: "@openclaw/normalization-core/phone-presentation",
      replacement: path.join(repoRoot, "packages/normalization-core/src/phone-presentation.ts"),
    });
  });

  it("uses Node package resolution for external packages inherited by worktrees", () => {
    const resolvePackage = vi.fn((specifier: string) =>
      path.join("/parent/node_modules", specifier),
    );

    const aliases = resolveExternalPackageAliasesForVite(resolvePackage);

    expect(resolvePackage.mock.calls).toEqual([
      ["@openclaw/libterminal/package.json"],
      ["@openclaw/uirouter/package.json"],
    ]);
    expect(aliases.find((alias) => alias.find === "@openclaw/libterminal/browser")).toEqual({
      find: "@openclaw/libterminal/browser",
      replacement: path.join("/parent/node_modules/@openclaw/libterminal", "dist/browser.js"),
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

      expect(resolved).toBe(path.join(repoRoot, "ui/src/lib/browser-redact.ts"));
    }
  });
});
