import { describe, expect, it } from "vitest";
import {
  isInboundPathAllowed,
  isValidInboundPathRootPattern,
  mergeInboundPathRoots,
} from "./inbound-path-policy.js";

describe("inbound-path-policy", () => {
  function expectInboundRootPatternCase(pattern: string, expected: boolean) {
    expect(isValidInboundPathRootPattern(pattern)).toBe(expected);
  }

  function expectInboundPathAllowedCase(filePath: string, expected: boolean) {
    expect(
      isInboundPathAllowed({ filePath, roots: ["/Users/*/Library/Messages/Attachments"] }),
    ).toBe(expected);
  }

  function expectMergedInboundPathRootsCase(params: {
    defaults: string[];
    additions: string[];
    expected: readonly string[];
  }) {
    expect(mergeInboundPathRoots(params.defaults, params.additions)).toEqual(params.expected);
  }

  it.each([
    { pattern: "/Users/*/Library/Messages/Attachments", expected: true },
    { pattern: "/Volumes/relay/attachments", expected: true },
    { pattern: "./attachments", expected: false },
    { pattern: "/Users/**/Attachments", expected: false },
  ] as const)("validates absolute root pattern %s", ({ pattern, expected }) => {
    expectInboundRootPatternCase(pattern, expected);
  });

  it.each([
    {
      filePath: "/Users/alice/Library/Messages/Attachments/12/34/ABCDEF/IMG_0001.jpeg",
      expected: true,
    },
    {
      filePath: "/etc/passwd",
      expected: false,
    },
  ] as const)("matches wildcard roots for %s => $expected", ({ filePath, expected }) => {
    expectInboundPathAllowedCase(filePath, expected);
  });

  it.each([
    {
      name: "normalizes and de-duplicates merged roots",
      run: () =>
        expectMergedInboundPathRootsCase({
          defaults: [
            "/Users/*/Library/Messages/Attachments/",
            "/Users/*/Library/Messages/Attachments",
          ],
          additions: ["/Volumes/relay/attachments"],
          expected: ["/Users/*/Library/Messages/Attachments", "/Volumes/relay/attachments"],
        }),
    },
  ] as const)("$name", ({ run }) => {
    run();
  });
});
