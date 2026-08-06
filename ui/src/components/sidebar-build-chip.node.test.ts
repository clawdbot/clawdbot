import { describe, expect, it } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { formatBuildChipText, formatSettingsBuildLabel } from "./sidebar-build-chip-format.ts";

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
    release: false,
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

describe("formatSettingsBuildLabel", () => {
  it("keeps official release artifacts version-only", () => {
    expect(formatSettingsBuildLabel(buildInfo({ release: true }), "2026.7.9")).toBe("2026.7.10");
  });

  it("adds a Git identity for clean main builds", () => {
    expect(formatSettingsBuildLabel(buildInfo(), "2026.7.9")).toBe("2026.7.10 · git@e8cbc62");
  });

  it("adds branch and dirty provenance for development builds", () => {
    expect(formatSettingsBuildLabel(buildInfo({ branch: "feat/x", dirty: true }), "2026.7.9")).toBe(
      "2026.7.10 · feat/x@e8cbc62*",
    );
  });

  it("falls back to the Gateway version when artifact metadata is unavailable", () => {
    expect(
      formatSettingsBuildLabel(
        buildInfo({ version: null, commit: null, branch: null, dirty: null }),
        "2026.7.9",
      ),
    ).toBe("2026.7.9");
  });

  it("keeps detached clean source builds distinguishable from releases", () => {
    expect(formatSettingsBuildLabel(buildInfo({ branch: null, dirty: false }), "2026.7.9")).toBe(
      "2026.7.10 · git@e8cbc62",
    );
  });
});
