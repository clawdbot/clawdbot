// Doctor disk-space tests cover byte formatting, warning generation, and note rendering.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerMaintenanceCommands } from "../cli/program/register.maintenance.js";
import { defaultRuntime } from "../runtime.js";
import { collectDiskSpaceHealthFindings, formatBytes, noteDiskSpace } from "./doctor-disk-space.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

function collectFindingsAt(availableBytes: number) {
  return collectDiskSpaceHealthFindings({ gateway: { mode: "local" } } as never, {
    env: { HOME: "/home/test" },
    readDiskSpace: () => ({ availableBytes }),
  });
}

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

describe("collectDiskSpaceHealthFindings thresholds", () => {
  it("returns empty array when space is sufficient", () => {
    expect(collectFindingsAt(10 * 1024 * 1024 * 1024)).toEqual([]);
  });

  it("returns a warning finding when space is low (below 500 MB)", () => {
    expect(collectFindingsAt(300 * 1024 * 1024)).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: expect.stringContaining("Low disk space"),
        target: "300 MB",
        requirement: "low-free-space",
      }),
    ]);
  });

  it("returns a critical finding when space is very low (below 100 MB)", () => {
    expect(collectFindingsAt(50 * 1024 * 1024)).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("CRITICAL"),
        target: "50 MB",
        requirement: "critical-free-space",
      }),
    ]);
  });

  it("returns critical at exactly 0 bytes", () => {
    expect(collectFindingsAt(0)).toEqual([
      expect.objectContaining({ severity: "error", requirement: "critical-free-space" }),
    ]);
  });

  it("keeps exactly 100 MB at warning severity", () => {
    expect(collectFindingsAt(100 * 1024 * 1024)).toEqual([
      expect.objectContaining({ severity: "warning", requirement: "low-free-space" }),
    ]);
  });

  it("returns empty at exactly 500 MB (boundary)", () => {
    expect(collectFindingsAt(500 * 1024 * 1024)).toEqual([]);
  });

  it("returns warning at 499 MB (just below boundary)", () => {
    expect(collectFindingsAt(499 * 1024 * 1024)).toEqual([
      expect.objectContaining({ requirement: "low-free-space" }),
    ]);
  });

  it("returns critical at exactly 99 MB (just below critical)", () => {
    expect(collectFindingsAt(99 * 1024 * 1024)).toEqual([
      expect.objectContaining({ severity: "error", requirement: "critical-free-space" }),
    ]);
  });
});

describe("registered doctor disk-space lint", () => {
  it.each([
    { availableMegabytes: 50, expectedExitCode: 1, expectedSeverity: "error" },
    { availableMegabytes: 100, expectedExitCode: 0, expectedSeverity: undefined },
  ])(
    "applies the actual error threshold and exit status at $availableMegabytes MB",
    async ({ availableMegabytes, expectedExitCode, expectedSeverity }) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-disk-space-"));
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        JSON.stringify({ gateway: { mode: "local" } }),
      );
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      const statfs = vi.spyOn(fs, "statfsSync").mockReturnValue({
        type: 0,
        bsize: 1024 * 1024,
        blocks: 1000,
        bfree: availableMegabytes,
        bavail: availableMegabytes,
        files: 0,
        frsize: 1024 * 1024,
        ffree: 0,
      });
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined);

      try {
        const program = new Command();
        registerMaintenanceCommands(program);
        await program.parseAsync(
          [
            "doctor",
            "--lint",
            "--only",
            "core/doctor/disk-space",
            "--severity-min",
            "error",
            "--json",
          ],
          { from: "user" },
        );

        expect(exit).toHaveBeenCalledWith(expectedExitCode);
        const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
        expect(payload).toMatchObject({
          ok: expectedExitCode === 0,
          checksRun: 1,
          findings:
            expectedSeverity === undefined
              ? []
              : [
                  expect.objectContaining({
                    checkId: "core/doctor/disk-space",
                    severity: expectedSeverity,
                  }),
                ],
        });
      } finally {
        exit.mockRestore();
        stdout.mockRestore();
        statfs.mockRestore();
        vi.unstubAllEnvs();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );
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

  it("returns a critical-space error finding", () => {
    const findings = collectDiskSpaceHealthFindings({ gateway: { mode: "local" } } as never, {
      env: { HOME: "/home/test" },
      readDiskSpace: () => ({ availableBytes: 50 * 1024 * 1024 }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/disk-space",
        severity: "error",
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
