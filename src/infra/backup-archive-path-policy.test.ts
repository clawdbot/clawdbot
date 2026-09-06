// Tests the archive symlink policy: which targets an archive may carry, and how
// a state link is mapped onto one.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { BackupAsset } from "../commands/backup-shared.js";
import {
  assertArchiveSymbolicLinkTarget,
  isUnrestorableSymbolicLinkTarget,
  remapDeclaredAbsoluteSymbolicLinkTarget,
} from "./backup-archive-path-policy.js";

const realpathSyncTargets = vi.hoisted(() => [] as string[]);

// `realpathSync` resolves a relative path against `process.cwd()`, so the policy
// must keep relative targets away from the filesystem or its verdict would follow
// the operator's shell. `process.chdir()` throws inside a Vitest worker, so record
// which targets reach the filesystem instead of comparing two directories.
vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return await mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    (actual) => ({
      realpathSync: Object.assign(
        (target: Parameters<typeof actual.realpathSync>[0]) => {
          realpathSyncTargets.push(String(target));
          return actual.realpathSync(target);
        },
        { native: actual.realpathSync.native },
      ) as typeof actual.realpathSync,
    }),
    { mirrorToDefault: true },
  );
});

const archiveRoot = "2026-09-06T12-00-00.000+00-00-openclaw-backup";
const stateAssetPath = `${archiveRoot}/payload/posix/Users/dev/.openclaw`;
const assets = [{ archivePath: stateAssetPath }];

// Payload encoding for an absolute POSIX source path, so a rewritten target is one
// hop instead of the whole temp-root chain.
const archiveEntryPathFor = (sourcePath: string): string =>
  `${archiveRoot}/payload/posix${sourcePath}`;

beforeEach(() => {
  realpathSyncTargets.length = 0;
});

describe("assertArchiveSymbolicLinkTarget", () => {
  it("accepts a relative target inside the same declared asset", () => {
    expect(() =>
      assertArchiveSymbolicLinkTarget({
        archiveRoot,
        entryPath: `${stateAssetPath}/postproc/parse_envelopes.py`,
        linkpath: "../shared/parse_envelopes.py",
        assets,
      }),
    ).not.toThrow();
  });

  it.each([
    {
      label: "an absolute target",
      linkpath: "/Users/dev/workplace/skills/parse_envelopes.py",
      error: /Archive symbolic link target must be relative/iu,
    },
    {
      label: "a relative target escaping the archive root",
      linkpath: "../../../../../../../etc/passwd",
      error: /Archive symbolic link target is outside the declared archive root/iu,
    },
    {
      label: "a relative target outside every declared asset",
      linkpath: "../../unrelated/secret.txt",
      error: /Archive symbolic link is outside the declared backup assets/iu,
    },
    {
      label: "a missing target",
      linkpath: undefined,
      error: /Archive symbolic link is missing its target/iu,
    },
  ])("refuses $label", ({ linkpath, error }) => {
    expect(() =>
      assertArchiveSymbolicLinkTarget({
        archiveRoot,
        entryPath: `${stateAssetPath}/postproc/parse_envelopes.py`,
        linkpath,
        assets,
      }),
    ).toThrow(error);
  });
});

// A target that is relative on the running platform must never be resolved, so
// neither answer can depend on where the operator's shell happens to be.
describe("cwd-relative symbolic link targets", () => {
  // A colon in a segment puts this target in the set the archive guard refuses as
  // non-relative, so it reaches the ownership question while staying relative.
  const relativeTargetWithDriveSegment = "sub/x:1";
  const declaredStatePath = path.resolve(path.sep, "declared", "state");
  const sourceAssets: BackupAsset[] = [
    {
      kind: "state",
      sourcePath: declaredStatePath,
      displayPath: declaredStatePath,
      archivePath: stateAssetPath,
    },
  ];

  it("reports one unrestorable without resolving the target", () => {
    expect(isUnrestorableSymbolicLinkTarget(relativeTargetWithDriveSegment, sourceAssets)).toBe(
      true,
    );
    expect(realpathSyncTargets).toEqual([]);
  });

  it("leaves one unremapped without resolving the target", () => {
    expect(
      remapDeclaredAbsoluteSymbolicLinkTarget({
        linkpath: relativeTargetWithDriveSegment,
        archiveEntryPath: archiveEntryPathFor(path.join(declaredStatePath, "bin", "link")),
        archiveRoot,
        assets: sourceAssets,
      }),
    ).toBe(relativeTargetWithDriveSegment);
    expect(realpathSyncTargets).toEqual([]);
  });
});

// The source-side predicates read the filesystem, so they need a real asset root.
describe.runIf(process.platform !== "win32")("state symbolic link mapping", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let sourceRoot: string;
  let stateSourcePath: string;
  let sourceAssets: BackupAsset[];

  beforeEach(() => {
    // The tracker resolves the system temp root, and containment compares the
    // link's real target against the asset path, so the declared root is canonical.
    sourceRoot = tempDirs.make("openclaw-link-policy-");
    stateSourcePath = path.join(sourceRoot, "state");
    mkdirSync(path.join(stateSourcePath, "bin"), { recursive: true });
    sourceAssets = [
      {
        kind: "state",
        sourcePath: stateSourcePath,
        displayPath: stateSourcePath,
        archivePath: stateAssetPath,
      },
    ];
    writeFileSync(path.join(sourceRoot, "outside.txt"), "outside\n", "utf8");
  });

  describe("isUnrestorableSymbolicLinkTarget", () => {
    it("keeps escaping relative targets with the archive guard", () => {
      // A relative escape resolves inside or beside the restored tree, so it is a
      // substitution hazard rather than an unrestorable link.
      expect(isUnrestorableSymbolicLinkTarget("../outside.txt", sourceAssets)).toBe(false);
    });

    it("reports an absolute target no declared asset owns", () => {
      expect(isUnrestorableSymbolicLinkTarget(path.join(sourceRoot, "outside.txt"), [])).toBe(true);
    });

    it("reports an absolute target that does not exist", () => {
      expect(isUnrestorableSymbolicLinkTarget(path.join(sourceRoot, "missing.txt"), [])).toBe(true);
    });

    it("reports an unowned absolute target containing a backslash", () => {
      // Ownership decides restorability, so a spelling rule must not exempt an
      // unowned target from the omission path and fail the whole backup instead.
      expect(isUnrestorableSymbolicLinkTarget(path.join(sourceRoot, "we\\ird.txt"), [])).toBe(true);
    });

    it("keeps a backslash target a declared asset owns with the archive guard", () => {
      // The payload encoder folds backslashes into slashes, so this target shares an
      // archive path with `we/ird.txt` and an archived link cannot say which it
      // means. Omitting it instead would drop a link into content the archive does
      // contain, which is a separate question from this omission path.
      const ownedTarget = path.join(stateSourcePath, "we\\ird.txt");
      writeFileSync(ownedTarget, "owned\n", "utf8");
      expect(isUnrestorableSymbolicLinkTarget(ownedTarget, sourceAssets)).toBe(false);
    });

    it("accepts an absolute target a declared asset owns", () => {
      const ownedTarget = path.join(stateSourcePath, "owned.txt");
      writeFileSync(ownedTarget, "owned\n", "utf8");
      expect(isUnrestorableSymbolicLinkTarget(ownedTarget, sourceAssets)).toBe(false);
    });
  });

  describe("remapDeclaredAbsoluteSymbolicLinkTarget", () => {
    it("rewrites an owned absolute target as an archive-relative one", () => {
      const ownedTarget = path.join(stateSourcePath, "config.json");
      writeFileSync(ownedTarget, "{}\n", "utf8");
      expect(
        remapDeclaredAbsoluteSymbolicLinkTarget({
          linkpath: ownedTarget,
          archiveEntryPath: archiveEntryPathFor(path.join(stateSourcePath, "bin", "link")),
          archiveRoot,
          assets: sourceAssets,
        }),
      ).toBe("../config.json");
    });

    // Rows resolve lazily: the temp asset root only exists once beforeEach ran.
    it.each([
      { label: "a relative target", resolveLinkpath: () => "../sibling.txt" },
      { label: "an unowned absolute target", resolveLinkpath: () => "/etc/hosts" },
      {
        label: "an absolute target containing a backslash",
        resolveLinkpath: () => path.join(stateSourcePath, "we\\ird.txt"),
      },
    ])("returns $label unchanged for the archive guard", ({ resolveLinkpath }) => {
      const linkpath = resolveLinkpath();
      expect(
        remapDeclaredAbsoluteSymbolicLinkTarget({
          linkpath,
          archiveEntryPath: archiveEntryPathFor(path.join(stateSourcePath, "bin", "link")),
          archiveRoot,
          assets: sourceAssets,
        }),
      ).toBe(linkpath);
    });
  });

  it("resolves one link target once across both answers in a run", () => {
    // Creation asks whether the link is restorable during traversal and where its
    // target lands while writing the entry, so one run cache keeps a link to a
    // single ownership walk.
    const ownedTarget = path.join(stateSourcePath, "config.json");
    writeFileSync(ownedTarget, "{}\n", "utf8");
    const ownedTargets = new Map<string, string | undefined>();

    expect(isUnrestorableSymbolicLinkTarget(ownedTarget, sourceAssets, ownedTargets)).toBe(false);
    expect(
      remapDeclaredAbsoluteSymbolicLinkTarget({
        linkpath: ownedTarget,
        archiveEntryPath: archiveEntryPathFor(path.join(stateSourcePath, "bin", "link")),
        archiveRoot,
        assets: sourceAssets,
        ownedTargets,
      }),
    ).toBe("../config.json");
    // The temp-dir helper canonicalizes the system temp root through the same
    // function, so count only this target's resolutions.
    expect(realpathSyncTargets.filter((target) => target === ownedTarget)).toEqual([ownedTarget]);
  });
});
