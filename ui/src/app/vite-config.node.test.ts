// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  hashControlUiTranslationText,
  loadControlUiSourceCatalog,
  readControlUiSourceCatalog,
} from "../../../scripts/lib/control-ui-i18n-catalog.ts";
import { flattenTranslations } from "../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { controlUiLocaleModulesPlugin } from "../../config/control-ui-locales.ts";
import {
  controlUiBrowserOnlySharedModuleAliases,
  createControlUiPrecompressedAssetVariants,
  resolveControlUiBuildInfo,
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../../vite.config.ts";
import { en } from "../i18n/locales/en.ts";

const childProcessMocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));
const fsMocks = vi.hoisted(() => ({ existsSync: vi.fn(), readFileSync: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessMocks.execFileSync.mockImplementation(actual.execFileSync);
  return { ...actual, execFileSync: childProcessMocks.execFileSync };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsMocks.existsSync.mockImplementation(actual.existsSync);
  fsMocks.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, existsSync: fsMocks.existsSync, readFileSync: fsMocks.readFileSync };
});

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
    const source = Array.from(
      { length: 200 },
      (_, index) => `console.log("startup-${index % 97}", ${index % 31});\n`,
    ).join("");
    const variants = createControlUiPrecompressedAssetVariants("assets/app-AbCd1234.js", source);

    expect(variants.map((variant) => variant.fileName)).toEqual([
      "assets/app-AbCd1234.js.br",
      "assets/app-AbCd1234.js.gz",
    ]);
    expect(brotliDecompressSync(variants[0]?.source ?? Buffer.alloc(0)).toString()).toBe(source);
    expect(gunzipSync(variants[1]?.source ?? Buffer.alloc(0)).toString()).toBe(source);
    expect(createHash("sha256").update(variants[1]!.source).digest("hex")).toBe(
      "32dab2f3598992a8a8b595f5da60f10907fc181c2abfa27380d562d9b539b85d",
    );
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
      release: false,
      buildId: "2026.7.10-0123456789ab-2026-07-10T12-34-56.000Z",
    });
    expect(readGitCommit).not.toHaveBeenCalled();
    expect(readGitCommitTimestamp).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef01234567");
  });

  it("keeps source-build identity stable when no build timestamp is provided", () => {
    const sources = {
      env: {},
      readGitCommit: () => "a".repeat(40),
      readGitCommitTimestamp: () => null,
      readGitBranch: () => null,
      readGitDirty: () => null,
      readPackageVersion: () => null,
    };
    const first = resolveControlUiBuildInfo(sources);
    const second = resolveControlUiBuildInfo(sources);

    expect(first).toEqual(second);
    expect(first).toEqual({
      version: null,
      commit: "a".repeat(40),
      commitAt: null,
      builtAt: null,
      branch: null,
      dirty: null,
      release: false,
      buildId: "aaaaaaaaaaaa",
    });
  });

  it("hard-kills every advisory Git read after its deadline", async () => {
    await childProcessMocks.execFileSync.withImplementation(
      ((_file: string, args?: readonly string[]) => {
        const commandArgs = args ?? [];
        if (commandArgs.includes("--format=%ct")) {
          return "0\n";
        }
        if (commandArgs.includes("--abbrev-ref")) {
          return "main\n";
        }
        if (commandArgs.includes("--porcelain")) {
          return "";
        }
        return `${"a".repeat(40)}\n`;
      }) as typeof import("node:child_process").execFileSync,
      async () => {
        childProcessMocks.execFileSync.mockClear();

        expect(
          resolveControlUiBuildInfo({
            env: {},
            readPackageVersion: () => null,
          }),
        ).toMatchObject({
          commit: "a".repeat(40),
          commitAt: "1970-01-01T00:00:00.000Z",
          branch: "main",
          dirty: false,
        });
        expect(childProcessMocks.execFileSync).toHaveBeenCalledTimes(4);
        for (const call of childProcessMocks.execFileSync.mock.calls) {
          const args = call[1];
          const options = call[2];
          expect(args).toContain("--no-optional-locks");
          expect(options).toMatchObject({
            killSignal: "SIGKILL",
            timeout: 2_000,
          });
        }
      },
    );
  });

  it("records release packaging as an explicit artifact fact", () => {
    expect(
      resolveControlUiBuildInfo({
        env: {
          OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1",
          OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T13:14:15.000Z",
        },
        readGitCommit: () => "a".repeat(40),
        readGitCommitTimestamp: () => null,
        readGitBranch: () => "release/2026.7.10",
        readGitDirty: () => false,
        readPackageVersion: () => "2026.7.10",
      }),
    ).toMatchObject({
      version: "2026.7.10",
      commit: "a".repeat(40),
      branch: "release/2026.7.10",
      dirty: false,
      release: true,
      buildId: "2026.7.10-release-aaaaaaaaaaaa-2026-07-10T13-14-15.000Z",
    });
  });

  it("rejects malformed release-build identity", () => {
    expect(() =>
      resolveControlUiBuildInfo({
        env: { OPENCLAW_CONTROL_UI_RELEASE_BUILD: "true" },
        readGitCommit: () => null,
        readPackageVersion: () => "2026.7.10",
      }),
    ).toThrow("OPENCLAW_CONTROL_UI_RELEASE_BUILD must be 1 when set");
  });

  it("uses checked-out Git instead of unverified GitHub workflow context", () => {
    const readGitCommit = vi.fn(() => "c".repeat(40));
    expect(
      resolveControlUiBuildInfo({
        env: { GITHUB_SHA: "b".repeat(40) },
        readGitCommit,
        readPackageVersion: () => null,
      }),
    ).toMatchObject({ commit: "c".repeat(40), commitAt: null });
    expect(readGitCommit).toHaveBeenCalledOnce();
    expect(
      resolveControlUiBuildInfo({
        env: { GITHUB_SHA: "b".repeat(40) },
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
      aliases.find((alias) => alias.find === "@openclaw/normalization-core/agent-id"),
    )?.toEqual({
      find: "@openclaw/normalization-core/agent-id",
      replacement: path.join(repoRoot, "packages/normalization-core/src/agent-id.ts"),
    });
    expect(
      aliases.find((alias) => alias.find === "@openclaw/normalization-core/json-schema"),
    )?.toEqual({
      find: "@openclaw/normalization-core/json-schema",
      replacement: path.join(repoRoot, "packages/normalization-core/src/json-schema.ts"),
    });
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
    const resultAliasIndex = aliases.findIndex(
      (alias) => alias.find === "@openclaw/normalization-core/result",
    );
    const rootAliasIndex = aliases.findIndex(
      (alias) => alias.find === "@openclaw/normalization-core",
    );
    expect(aliases[resultAliasIndex]).toEqual({
      find: "@openclaw/normalization-core/result",
      replacement: path.join(repoRoot, "packages/normalization-core/src/result.ts"),
    });
    expect(resultAliasIndex).toBeGreaterThanOrEqual(0);
    expect(rootAliasIndex).toBeGreaterThan(resultAliasIndex);
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

  it("composes the complete source without registering runtime English", () => {
    const before = structuredClone(en);
    const source = loadControlUiSourceCatalog();
    const flat = flattenTranslations(source);

    expect(en).toEqual(before);
    expect(source).not.toBe(en);
    expect(source.configView).not.toBe(en.configView);
    expect(flat.get("activity.title")).toBe("Activity");
    expect(flat.get("memoryImport.title")).toBe("Import assistant memory");
    expect(flat.get("sessionsView.runsOnDevice")).toBe("Runs on device");
    expect(flat.get("pluginConsent.widenedTitle")).toBe("What changed");
    expect(flat.get("configPage.themeImported")).toBe("Imported {name}.");
    expect(flat.get("configView.sections.cron")).toBe("Automations");
    expect(flat.get("updates.page.intro")).toBe(
      "Manage the connected Gateway's release channel and update policy.",
    );
  });

  it("includes every English dependency in the raw source-hash input", async () => {
    const localesDir = path.join(repoRoot, "ui/src/i18n/locales");
    const sourceRaw = await readControlUiSourceCatalog();
    const englishFiles = readdirSync(localesDir).filter(
      (file) => /^en(?:-.+)?\.ts$/.test(file) && !file.endsWith(".test.ts"),
    );

    for (const file of englishFiles) {
      expect(sourceRaw, file).toContain(readFileSync(path.join(localesDir, file), "utf8"));
    }
  });

  it("materializes lazy locale modules from their watched canonical translation memory", async () => {
    const plugin = controlUiLocaleModulesPlugin();
    const resolveHook = plugin.resolveId;
    const resolveId = typeof resolveHook === "function" ? resolveHook : resolveHook?.handler;
    const loadHook = plugin.load;
    const load = typeof loadHook === "function" ? loadHook : loadHook?.handler;
    if (!resolveId || !load) {
      throw new Error("Expected locale module resolver and loader");
    }
    const id = "virtual:openclaw-control-ui-locale/fr";
    const resolved = await resolveId.call({} as never, id, undefined, {} as never);
    expect(resolved).toBe(`\0${id}`);
    expect(
      await resolveId.call({} as never, `${id}/../../secret`, undefined, {} as never),
    ).toBeNull();

    const addWatchFile = vi.fn();
    const result = await load.call({ addWatchFile } as never, resolved as string, {} as never);
    if (typeof result !== "string") {
      throw new Error("Expected locale module loader to return generated source");
    }
    const catalog = JSON.parse(result.replace(/^export default /, "").replace(/;$/, ""));
    expect(catalog.common.health).toBe("Santé");
    expect(catalog.activity.title).toBeTypeOf("string");
    expect(addWatchFile).toHaveBeenCalledWith(path.join(repoRoot, "ui/src/i18n/.i18n/fr.tm.jsonl"));
  });

  it("bootstraps only an absent locale memory from the English catalog", async () => {
    const loadHook = controlUiLocaleModulesPlugin().load;
    const load = typeof loadHook === "function" ? loadHook : loadHook?.handler;
    if (!load) {
      throw new Error("Expected locale module loader");
    }
    const id = "\0virtual:openclaw-control-ui-locale/fr";
    const addWatchFile = vi.fn();

    await fsMocks.existsSync.withImplementation(
      () => false,
      async () => {
        const result = await load.call({ addWatchFile } as never, id, {} as never);
        if (typeof result !== "string") {
          throw new Error("Expected locale module loader to return generated source");
        }
        const catalog = JSON.parse(result.replace(/^export default /, "").replace(/;$/, ""));
        expect([...flattenTranslations(catalog)]).toEqual([
          ...flattenTranslations(loadControlUiSourceCatalog()),
        ]);
        expect(addWatchFile).not.toHaveBeenCalled();
      },
    );

    await fsMocks.readFileSync.withImplementation(
      () => "",
      async () => {
        expect(() => load.call({ addWatchFile } as never, id, {} as never)).toThrow(
          "Control UI fr translation memory is missing or empty",
        );
      },
    );
    await fsMocks.readFileSync.withImplementation(
      () => "{",
      async () => {
        expect(() => load.call({ addWatchFile } as never, id, {} as never)).toThrow(SyntaxError);
      },
    );
  });

  it("omits stale and missing Settings translations so runtime English can resolve them", async () => {
    const loadHook = controlUiLocaleModulesPlugin().load;
    const load = typeof loadHook === "function" ? loadHook : loadHook?.handler;
    if (!load) {
      throw new Error("Expected locale module loader");
    }
    const memory = [
      {
        cache_key: "current",
        segment_id: "configView.chatPrefs.title",
        text_hash: hashControlUiTranslationText("Chat"),
        translated: "Discussion",
      },
      {
        cache_key: "stale",
        segment_id: "updates.page.intro",
        text_hash: hashControlUiTranslationText("Retired update introduction"),
        translated: "Obsolete",
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    await fsMocks.existsSync.withImplementation(
      () => true,
      async () => {
        await fsMocks.readFileSync.withImplementation(
          () => memory,
          async () => {
            const result = await load.call(
              { addWatchFile: vi.fn() } as never,
              "\0virtual:openclaw-control-ui-locale/fr",
              {} as never,
            );
            if (typeof result !== "string") {
              throw new Error("Expected locale module loader to return generated source");
            }
            expect(JSON.parse(result.replace(/^export default /, "").replace(/;$/, ""))).toEqual({
              configView: { chatPrefs: { title: "Discussion" } },
            });
          },
        );
      },
    );
  });
});
