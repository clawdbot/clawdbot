import { describe, expect, it } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { formatBuildChipText } from "./sidebar-build-chip-format.ts";

const COMMIT = "e8cbc62f0123456789abcdef0123456789abcdef";
const BUILT_AT = "2026-07-10T12:00:00.000Z";

function buildInfo(overrides: Partial<ControlUiBuildInfo> = {}): ControlUiBuildInfo {
  return {
    version: "2026.7.10",
    commit: COMMIT,
    commitAt: null,
    builtAt: BUILT_AT,
    branch: "main",
    dirty: false,
    buildId: "test",
    ...overrides,
  };
}

describe("formatBuildChipText", () => {
  const cases: Array<{
    name: string;
    info: ControlUiBuildInfo;
    expected: string | null;
  }> = [
    {
      name: "main clean build",
      info: buildInfo(),
      expected: "e8cbc62",
    },
    {
      name: "non-main branch",
      info: buildInfo({ branch: "feat/x" }),
      expected: "feat/x@e8cbc62",
    },
    {
      name: "dirty worktree",
      info: buildInfo({ dirty: true }),
      expected: "e8cbc62*",
    },
    {
      name: "missing commit",
      info: buildInfo({ commit: null }),
      expected: null,
    },
    {
      name: "long branch",
      info: buildInfo({ branch: "abcdefghijklmnop" }),
      expected: "abcdefghijklmn…@e8cbc62",
    },
    {
      name: "long branch keeps an emoji that fits exactly at the boundary",
      info: buildInfo({ branch: `${"a".repeat(12)}😀suffix` }),
      expected: "aaaaaaaaaaaa😀…@e8cbc62",
    },
    {
      name: "long branch does not split an emoji across the boundary",
      info: buildInfo({ branch: `${"a".repeat(13)}😀suffix` }),
      expected: "aaaaaaaaaaaaa…@e8cbc62",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(formatBuildChipText(testCase.info)).toBe(testCase.expected);
    });
  }
});
