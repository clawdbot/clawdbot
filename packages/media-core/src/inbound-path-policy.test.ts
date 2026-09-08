import { describe, expect, it } from "vitest";
import {
  isInboundPathAllowed,
  isValidInboundPathRootPattern,
  mergeInboundPathRoots,
  resolveInboundPathRoot,
} from "./inbound-path-policy.js";

describe("inbound-path-policy", () => {
  it.each([
    { pattern: "/Users/*/Library/Messages/Attachments", expected: true },
    { pattern: "/Volumes/relay/attachments", expected: true },
    { pattern: "./attachments", expected: false },
    { pattern: "/Users/**/Attachments", expected: false },
  ] as const)("validates absolute root pattern %s", ({ pattern, expected }) => {
    expect(isValidInboundPathRootPattern(pattern)).toBe(expected);
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
    expect(
      isInboundPathAllowed({ filePath, roots: ["/Users/*/Library/Messages/Attachments"] }),
    ).toBe(expected);
  });

  it("matches Windows drive roots case-insensitively", () => {
    expect(
      isInboundPathAllowed({
        filePath: "C:\\Users\\Alice\\Library\\Messages\\Attachments\\12\\34\\ABCDEF\\IMG_0001.jpeg",
        roots: ["c:/users/*/library/messages/attachments"],
      }),
    ).toBe(true);
  });

  it("resolves wildcard patterns to the concrete matched root", () => {
    expect(
      resolveInboundPathRoot({
        filePath: "/Users/alice/Library/Messages/Attachments/12/34/IMG_0001.jpeg",
        roots: ["/Users/*/Library/Messages/Attachments"],
      }),
    ).toEqual({
      anchorRoot: "/Users",
      matchedRoot: "/Users/alice/Library/Messages/Attachments",
    });
    expect(
      resolveInboundPathRoot({
        filePath: "C:\\Users\\Alice\\Library\\Messages\\Attachments\\12\\IMG_0001.jpeg",
        roots: ["c:/users/*/library/messages/attachments"],
      }),
    ).toEqual({
      anchorRoot: "c:/users",
      matchedRoot: "c:/users/alice/library/messages/attachments",
    });
    expect(
      resolveInboundPathRoot({
        filePath: "/tmp/inbound/file.bin",
        roots: ["/*"],
      }),
    ).toEqual({
      anchorRoot: "/",
      matchedRoot: "/tmp",
    });
    expect(
      resolveInboundPathRoot({
        filePath: "C:\\inbound\\file.bin",
        roots: ["c:/*"],
      }),
    ).toEqual({
      anchorRoot: "c:/",
      matchedRoot: "c:/inbound",
    });
  });

  it("normalizes and de-duplicates merged roots", () => {
    expect(
      mergeInboundPathRoots(
        ["/Users/*/Library/Messages/Attachments/", "/Users/*/Library/Messages/Attachments"],
        ["/Volumes/relay/attachments"],
      ),
    ).toEqual(["/Users/*/Library/Messages/Attachments", "/Volumes/relay/attachments"]);
  });
});
