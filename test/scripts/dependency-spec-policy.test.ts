import { describe, expect, it } from "vitest";
import { classifyDependencySpec } from "../../scripts/lib/dependency-spec-policy.mts";

describe("dependency spec policy", () => {
  it.each([
    ["exact registry version", "1.2.3", true, false],
    ["prerelease registry version", "1.2.3-beta.1", true, false],
    ["build registry version", "1.2.3+build.1", true, false],
    ["leading-zero registry version", "01.2.3", false, false],
    ["malformed prerelease", "1.2.3-a..b", false, false],
    ["trimmed registry version", " 1.2.3", false, false],
    ["v-prefixed registry version", "v1.2.3", false, false],
    ["equals-prefixed registry version", "=1.2.3", false, false],
    ["range", "^1.2.3", false, false],
    ["tag", "latest", false, false],
    ["exact unscoped alias", "npm:real-package@2.3.4", true, false],
    ["exact scoped alias", "npm:@scope/real-package@2.3.4", true, false],
    ["ranged alias", "npm:@scope/real-package@^2.3.4", false, false],
    ["nested alias", "npm:alias@npm:real-package@2.3.4", false, false],
    ["workspace package", "workspace:*", true, false],
    ["ranged workspace package", "workspace:^", false, false],
    ["file package", "file:../local", true, false],
    ["linked package", "link:../linked", true, false],
    ["empty file package", "file:", false, false],
    ["empty linked package", "link:", false, false],
    ["whitespace-only file package", "file: ", false, false],
    ["whitespace-only linked package", "link:\t", false, false],
    ["unsupported path package", "path:../local", false, false],
    [
      "SHA-pinned hosted Git package",
      "github:owner/repo#0123456789abcdef0123456789abcdef01234567",
      true,
      true,
    ],
    [
      "SHA-pinned Git package with empty path",
      "github:owner/repo#0123456789abcdef0123456789abcdef01234567&path:",
      false,
      true,
    ],
    [
      "SHA-pinned Git package with multiple paths",
      "github:owner/repo#0123456789abcdef0123456789abcdef01234567&path:a&path:b",
      false,
      true,
    ],
    [
      "SHA-pinned Git package with path",
      "git+ssh://git@example.test/owner/repo.git#0123456789abcdef0123456789abcdef01234567&path:packages/pkg",
      true,
      true,
    ],
    ["branch Git package", "github:owner/repo#main", false, true],
    ["short-SHA Git package", "gitlab:owner/repo#0123456", false, true],
    [
      "fragment-less Git commit path",
      "git+https://github.com/owner/repo/commit/0123456789abcdef0123456789abcdef01234567",
      false,
      true,
    ],
    [
      "branch plus false commit path",
      "github:owner/repo#main&path:packages/commit/0123456789abcdef0123456789abcdef01234567",
      false,
      true,
    ],
    [
      "SHA-pinned GitHub codeload package",
      "https://codeload.github.com/owner/repo/tar.gz/0123456789abcdef0123456789abcdef01234567",
      true,
      true,
    ],
    [
      "queried GitHub codeload package",
      "https://codeload.github.com/owner/repo/tar.gz/0123456789abcdef0123456789abcdef01234567?x=1",
      false,
      true,
    ],
    ["remote archive", "https://example.test/package.tgz", false, true],
    ["Git protocol", "git://example.test/owner/repo.git#main", false, true],
    ["SSH Git package", "ssh://git@example.test/owner/repo.git#main", false, true],
    ["scp-style Git package", "git@example.test:owner/repo.git#main", false, true],
    ["unknown protocol", "custom:package", false, false],
    ["empty spec", "", false, false],
    ["non-string spec", 42, false, false],
  ])("%s", (_name, spec, allowedPinned, exotic) => {
    expect(classifyDependencySpec(spec)).toEqual({ allowedPinned, exotic });
  });
});
