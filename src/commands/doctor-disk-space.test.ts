// Doctor disk-space tests cover byte formatting, warning generation, and note rendering.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildDiskSpaceWarnings,
  collectDiskSpaceHealthFindings,
  formatBytes,
  noteDiskSpace,
} from "./doctor-disk-space.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

describe("formatBytes", () => {
  it("formats zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes below 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("formats megabytes", () => {
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });

  it("floors megabytes to avoid crossing a threshold (99.6 MB -> 99 MB)", () => {
    expect(formatBytes(Math.floor(99.6 * 1024 * 1024))).toBe("99 MB");
  });

  it("formats gigabytes with one decimal", () => {
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });

  it("returns unknown for negative values", () => {
    expect(formatBytes(-1)).toBe("unknown");
  });

  it("returns unknown for NaN", () => {
    expect(formatBytes(Number.NaN)).toBe("unknown");
  });

  it("returns unknown for Infinity", () => {
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});

describe("buildDiskSpaceWarnings", () => {
  it("returns empty array when space is sufficient", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 10 * 1024 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toEqual([]);
  });

  it("returns warning lines when space is low (below 500 MB)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 300 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("Low disk space");
    expect(warnings[0]).toContain("300 MB");
    expect(warnings[0]).toContain("~/.openclaw");
  });

  it("returns critical lines when space is very low (below 100 MB)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 50 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("CRITICAL");
    expect(warnings[0]).toContain("50 MB");
  });

  it("returns critical at exactly 0 bytes", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 0,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("CRITICAL");
  });

  it("returns empty at exactly 500 MB (boundary)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 500 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toEqual([]);
  });

  it("returns warning at 499 MB (just below boundary)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 499 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("Low disk space");
  });

  it("returns critical at exactly 99 MB (just below critical)", () => {
    const warnings = buildDiskSpaceWarnings({
      availableBytes: 99 * 1024 * 1024,
      displayStateDir: "~/.openclaw",
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("CRITICAL");
  });
});

describe("noteDiskSpace", () => {
  it("calls note when space is below warning threshold", async () => {
    const { note: mockNote } = await import("../../packages/terminal-core/src/note.js");
    vi.mocked(mockNote).mockClear();

    noteDiskSpace({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => ({ availableBytes: 300 * 1024 * 1024 }),
    });

    expect(mockNote).toHaveBeenCalledOnce();
    const [message, title] = expectDefined(
      vi.mocked(mockNote).mock.calls[0],
      "vi.mocked(mockNote).mock.calls[0] test invariant",
    );
    expect(title).toBe("Disk space");
    expect(message).toContain("Low disk space");
  });

  it("calls note with CRITICAL when space is very low", async () => {
    const { note: mockNote } = await import("../../packages/terminal-core/src/note.js");
    vi.mocked(mockNote).mockClear();

    noteDiskSpace({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => ({ availableBytes: 50 * 1024 * 1024 }),
    });

    expect(mockNote).toHaveBeenCalledOnce();
    const [message] = expectDefined(
      vi.mocked(mockNote).mock.calls[0],
      "vi.mocked(mockNote).mock.calls[0] test invariant",
    );
    expect(message).toContain("CRITICAL");
  });

  it("does not call note when space is sufficient", async () => {
    const { note: mockNote } = await import("../../packages/terminal-core/src/note.js");
    vi.mocked(mockNote).mockClear();

    noteDiskSpace({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => ({ availableBytes: 10 * 1024 * 1024 * 1024 }),
    });

    expect(mockNote).not.toHaveBeenCalled();
  });

  it("does not call note when disk space cannot be read", async () => {
    const { note: mockNote } = await import("../../packages/terminal-core/src/note.js");
    vi.mocked(mockNote).mockClear();

    noteDiskSpace({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => null,
    });

    expect(mockNote).not.toHaveBeenCalled();
  });
});

describe("collectDiskSpaceHealthFindings", () => {
  it("returns a low-space warning finding", () => {
    const findings = collectDiskSpaceHealthFindings({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => ({ availableBytes: 300 * 1024 * 1024 }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/disk-space",
        severity: "warning",
        message: "Low disk space: 300 MB free on the partition containing /home/test/.openclaw.",
        path: "/home/test/.openclaw",
        target: "300 MB",
        requirement: "low-free-space",
        fixHint: expect.stringContaining("prevent future config/session write failures"),
      }),
    ]);
  });

  it("returns a critical-space warning finding", () => {
    const findings = collectDiskSpaceHealthFindings({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => ({ availableBytes: 50 * 1024 * 1024 }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/disk-space",
        severity: "warning",
        message: "CRITICAL: only 50 MB free on the partition containing /home/test/.openclaw.",
        path: "/home/test/.openclaw",
        target: "50 MB",
        requirement: "critical-free-space",
        fixHint: expect.stringContaining("avoid data loss"),
      }),
    ]);
  });

  it("returns no finding when space is sufficient", () => {
    const findings = collectDiskSpaceHealthFindings({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => ({ availableBytes: 10 * 1024 * 1024 * 1024 }),
    });

    expect(findings).toEqual([]);
  });

  it("returns no finding when disk space cannot be read", () => {
    const findings = collectDiskSpaceHealthFindings({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => null,
    });

    expect(findings).toEqual([]);
  });
});
