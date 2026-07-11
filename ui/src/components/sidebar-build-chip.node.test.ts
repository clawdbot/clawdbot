import { describe, expect, it } from "vitest";
import type { ControlUiBuildInfo } from "../build-info.ts";
import { formatBuildChipText } from "./sidebar-build-chip.ts";

const COMMIT = "e8cbc62f0123456789abcdef0123456789abcdef";
const BUILT_AT = "2026-07-10T12:00:00.000Z";

function buildInfo(overrides: Partial<ControlUiBuildInfo> = {}): ControlUiBuildInfo {
  return {
    version: "2026.7.10",
    commit: COMMIT,
    builtAt: BUILT_AT,
    branch: "main",
    dirty: false,
    buildId: "test",
    ...overrides,
  };
}

describe("formatBuildChipText", () => {
  const nowMs = Date.parse(BUILT_AT) + 24 * 60_000;
  const cases: Array<{
    name: string;
    info: ControlUiBuildInfo;
    nowMs?: number;
    expected: string | null;
  }> = [
    {
      name: "main clean build",
      info: buildInfo(),
      expected: "e8cbc62 · 24m",
    },
    {
      name: "non-main branch",
      info: buildInfo({ branch: "feat/x", builtAt: "2026-07-10T12:19:00.000Z" }),
      expected: "feat/x@e8cbc62 · 5m",
    },
    {
      name: "dirty worktree",
      info: buildInfo({ dirty: true, builtAt: "2026-07-10T09:00:00.000Z" }),
      expected: "e8cbc62* · 3h",
    },
    {
      name: "missing build timestamp",
      info: buildInfo({ builtAt: null }),
      expected: "e8cbc62",
    },
    {
      name: "missing commit",
      info: buildInfo({ commit: null }),
      expected: null,
    },
    {
      name: "long branch",
      info: buildInfo({ branch: "abcdefghijklmnop", builtAt: null }),
      expected: "abcdefghijklmn…@e8cbc62",
    },
    {
      name: "future build timestamp",
      info: buildInfo({ builtAt: "2026-07-10T12:25:00.000Z" }),
      expected: "e8cbc62 · 0s",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(formatBuildChipText(testCase.info, testCase.nowMs ?? nowMs)).toBe(testCase.expected);
    });
  }
});
