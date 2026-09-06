// Tests the archive symlink guard that keeps restores inside the declared assets.
import { describe, expect, it } from "vitest";
import { assertArchiveSymbolicLinkTarget } from "./backup-archive-path-policy.js";

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
