import { describe, expect, it } from "vitest";
import {
  deriveControlUiBuildId,
  normalizeControlUiBuildInfo,
  normalizeControlUiBranch,
  normalizeControlUiBuildTimestamp,
  normalizeControlUiCommit,
} from "./build-info.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("Control UI build info", () => {
  it("keeps only full Git SHAs", () => {
    expect(normalizeControlUiCommit(COMMIT.toUpperCase())).toBe(COMMIT);
    expect(normalizeControlUiCommit(COMMIT.slice(0, 12))).toBeNull();
    expect(normalizeControlUiCommit("not-a-sha")).toBeNull();
  });

  it("normalizes advisory branch identity", () => {
    expect(normalizeControlUiBranch("  feature/build-chip  ")).toBe("feature/build-chip");
    expect(normalizeControlUiBranch("HEAD")).toBeNull();
    expect(normalizeControlUiBranch(" ")).toBeNull();
    expect(normalizeControlUiBranch("x".repeat(101))).toBe("x".repeat(100));
  });

  it("canonicalizes only valid UTC build timestamps", () => {
    expect(normalizeControlUiBuildTimestamp("2026-07-10T12:34:56Z")).toBe(
      "2026-07-10T12:34:56.000Z",
    );
    expect(normalizeControlUiBuildTimestamp("2026-07-10T12:34:56.123Z")).toBe(
      "2026-07-10T12:34:56.123Z",
    );
    expect(normalizeControlUiBuildTimestamp("2026-07-10T12:34:56.7Z")).toBe(
      "2026-07-10T12:34:56.700Z",
    );
    expect(normalizeControlUiBuildTimestamp("2026-07-10T12:34:56.12Z")).toBe(
      "2026-07-10T12:34:56.120Z",
    );
    expect(normalizeControlUiBuildTimestamp("2026-02-30T12:34:56Z")).toBeNull();
    expect(normalizeControlUiBuildTimestamp("2026-07-10T12:34:56+00:00")).toBeNull();
  });

  it("renders invalid injected metadata as unavailable instead of inventing identity", () => {
    expect(
      normalizeControlUiBuildInfo({
        version: "  ",
        commit: "deadbeef",
        builtAt: "later",
        branch: "HEAD",
        dirty: "yes",
        buildId: "",
      }),
    ).toEqual({
      version: null,
      commit: null,
      builtAt: null,
      branch: null,
      dirty: null,
      buildId: "dev",
    });
  });

  it("passes through normalized branch and boolean dirty state", () => {
    expect(normalizeControlUiBuildInfo({ branch: " feature/x ", dirty: false })).toMatchObject({
      branch: "feature/x",
      dirty: false,
    });
  });

  it("derives a stable service-worker id from the same artifact metadata", () => {
    expect(
      deriveControlUiBuildId({
        version: "2026.7.10",
        commit: COMMIT,
        builtAt: "2026-07-10T12:34:56.000Z",
      }),
    ).toBe("2026.7.10-0123456789ab-2026-07-10T12-34-56.000Z");
  });
});
