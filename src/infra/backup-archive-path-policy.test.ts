// Tests the archive symlink policy: which targets an archive may carry, and how
// a state link is mapped onto one.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BackupAsset } from "../commands/backup-shared.js";
import {
  assertArchiveSymbolicLinkTarget,
  isUnrestorableSymbolicLinkTarget,
  remapDeclaredAbsoluteSymbolicLinkTarget,
} from "./backup-archive-path-policy.js";

const archiveRoot = "2026-09-06T12-00-00.000+00-00-openclaw-backup";
const stateAssetPath = `${archiveRoot}/payload/posix/Users/dev/.openclaw`;
const assets = [{ archivePath: stateAssetPath }];

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

// The source-side predicates read the filesystem, so they need a real asset root.
describe.runIf(process.platform !== "win32")("state symbolic link mapping", () => {
  let sourceRoot: string;
  let stateSourcePath: string;
  let sourceAssets: BackupAsset[];

  beforeAll(() => {
    // macOS resolves the temp root through /private, and containment compares the
    // link's real target against the asset path, so declare the resolved root.
    sourceRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "openclaw-link-policy-")));
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

  afterAll(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
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
      // Restorability is decided by ownership, not spelling. While the remap
      // predicate answered both questions, its backslash rule made this link look
      // restorable, so it reached the archive guard and failed the whole backup.
      expect(isUnrestorableSymbolicLinkTarget(path.join(sourceRoot, "we\\ird.txt"), [])).toBe(true);
    });

    it("keeps a backslash target a declared asset owns with the archive guard", () => {
      // The payload encoding folds backslashes into slashes, so this link cannot
      // be represented faithfully. Omitting it would drop a link into content the
      // archive does contain, which is a separate question from this omission path.
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
    // Payload encoding for an absolute POSIX source path, so the rewritten target
    // is one hop instead of the whole temp-root chain.
    const archiveEntryPathFor = (sourcePath: string): string =>
      `${archiveRoot}/payload/posix${sourcePath}`;

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

    // Rows resolve lazily: the temp asset root only exists once beforeAll ran.
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
});
