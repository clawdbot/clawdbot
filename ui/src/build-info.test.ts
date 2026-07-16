import { describe, expect, it } from "vitest";
import { normalizeControlUiBuildInfo } from "./build-info-normalizers.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("Control UI build info", () => {
  it("keeps only full Git SHAs", () => {
    expect(normalizeControlUiBuildInfo({ commit: COMMIT.toUpperCase() }).commit).toBe(COMMIT);
    expect(normalizeControlUiBuildInfo({ commit: COMMIT.slice(0, 12) }).commit).toBeNull();
    expect(normalizeControlUiBuildInfo({ commit: "not-a-sha" }).commit).toBeNull();
  });

  it("normalizes advisory branch identity", () => {
    expect(normalizeControlUiBuildInfo({ branch: "  feature/build-chip  " }).branch).toBe(
      "feature/build-chip",
    );
    expect(normalizeControlUiBuildInfo({ branch: "HEAD" }).branch).toBeNull();
    expect(normalizeControlUiBuildInfo({ branch: " " }).branch).toBeNull();
    expect(normalizeControlUiBuildInfo({ branch: "x".repeat(101) }).branch).toBe("x".repeat(100));
    expect(normalizeControlUiBuildInfo({ branch: `${"x".repeat(98)}😀tail` }).branch).toBe(
      `${"x".repeat(98)}😀`,
    );
    expect(normalizeControlUiBuildInfo({ branch: `${"x".repeat(99)}😀tail` }).branch).toBe(
      "x".repeat(99),
    );
  });

  it("canonicalizes only valid UTC build timestamps", () => {
    expect(normalizeControlUiBuildInfo({ builtAt: "2026-07-10T12:34:56Z" }).builtAt).toBe(
      "2026-07-10T12:34:56.000Z",
    );
    expect(normalizeControlUiBuildInfo({ builtAt: "2026-07-10T12:34:56.123Z" }).builtAt).toBe(
      "2026-07-10T12:34:56.123Z",
    );
    expect(normalizeControlUiBuildInfo({ builtAt: "2026-07-10T12:34:56.7Z" }).builtAt).toBe(
      "2026-07-10T12:34:56.700Z",
    );
    expect(normalizeControlUiBuildInfo({ builtAt: "2026-07-10T12:34:56.12Z" }).builtAt).toBe(
      "2026-07-10T12:34:56.120Z",
    );
    expect(normalizeControlUiBuildInfo({ builtAt: "2026-02-30T12:34:56Z" }).builtAt).toBeNull();
    expect(
      normalizeControlUiBuildInfo({ builtAt: "2026-07-10T12:34:56+00:00" }).builtAt,
    ).toBeNull();
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
      normalizeControlUiBuildInfo({
        version: "2026.7.10",
        commit: COMMIT,
        builtAt: "2026-07-10T12:34:56.000Z",
      }).buildId,
    ).toBe("2026.7.10-0123456789ab-2026-07-10T12-34-56.000Z");
  });
});
