import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => "linux"),
  readFile: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, platform: mocks.platform } };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: { ...actual, readFile: mocks.readFile },
  };
});
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));

describe("system disk snapshots", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.platform.mockReturnValue("linux");
    mocks.runCommandWithTimeout.mockImplementation(async (argv: string[]) => ({
      code: 0,
      stdout: argv
        .slice(2)
        .map((mountPath) => `/dev/disk 2000 1000 1000 50% ${mountPath}`)
        .join("\n"),
    }));
  });
  afterEach(() => vi.useRealTimers());

  it("reports distinct Linux storage mounts, not bind aliases or memory and image filesystems", async () => {
    mocks.readFile.mockResolvedValue(
      [
        "1 0 8:1 / / rw - ext4 /dev/sda1 rw",
        "2 1 8:2 /work /srv/bind rw - xfs /dev/sdb1 rw",
        "3 1 8:2 / /mnt/data\\040disk rw - xfs /dev/sdb1 rw",
        "4 1 0:1 / /run rw - tmpfs tmpfs rw",
        "5 1 7:0 / /snap/package ro - squashfs /dev/loop0 ro",
        "6 1 0:2 / /tank rw - zfs tank rw",
      ].join("\n"),
    );
    const { readSystemDisks } = await import("./system-disks.js");
    expect(await readSystemDisks()).toEqual([
      { path: "/", totalBytes: 2_048_000, availableBytes: 1_024_000 },
      { path: "/mnt/data disk", totalBytes: 2_048_000, availableBytes: 1_024_000 },
      { path: "/tank", totalBytes: 2_048_000, availableBytes: 1_024_000 },
    ]);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      ["df", "-kP", "/", "/mnt/data disk", "/tank"],
      expect.objectContaining({ timeoutMs: 3_000, maxOutputBytes: 1024 * 1024 }),
    );
  });

  it.each([
    { directory: "removed", code: 1, stdout: "overlay 2000 2001 -1 101% /\n" },
    {
      directory: "remaining",
      code: 0,
      stdout: "overlay 2000 2001 -1 101% /\noverlay 2000 2001 -1 101% /\n",
    },
  ])(
    "keeps one container root when a volume disappears with its directory $directory",
    async ({ code, stdout }) => {
      mocks.readFile.mockResolvedValue(
        "1 0 0:5 / / rw - overlay overlay rw\n2 1 8:1 / /data rw - ext4 /dev/sdb rw",
      );
      mocks.runCommandWithTimeout.mockResolvedValue({ code, stdout });
      const { readSystemDisks } = await import("./system-disks.js");
      expect(await readSystemDisks()).toEqual([
        { path: "/", totalBytes: 2_048_000, availableBytes: 0 },
      ]);
    },
  );

  it.each(["tmpfs tmpfs", "nfs server:/root", "nfs4 server:/root"])(
    "excludes a non-local Linux root (%s) without hiding local data disks",
    async (filesystem) => {
      mocks.readFile.mockResolvedValue(
        `1 0 0:5 / / rw - ${filesystem} rw\n2 1 8:1 / /data rw - ext4 /dev/sdb rw`,
      );
      const { readSystemDisks } = await import("./system-disks.js");
      expect((await readSystemDisks())?.map((disk) => disk.path)).toEqual(["/data"]);
    },
  );

  it("keeps macOS root and browsable volumes without duplicating hidden APFS volumes", async () => {
    mocks.platform.mockReturnValue("darwin");
    mocks.runCommandWithTimeout.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
        "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, root data)",
        "/dev/disk3s6 on /System/Volumes/VM (apfs, local, nobrowse)",
        "/dev/disk7s1 on /Volumes/Data Disk (apfs, local, nodev, nosuid)",
        "devfs on /dev (devfs, local, nobrowse)",
        "server:/share on /Volumes/Network (nfs)",
      ].join("\n"),
    });
    const { readSystemDisks } = await import("./system-disks.js");
    expect((await readSystemDisks())?.map((disk) => disk.path)).toEqual([
      "/",
      "/Volumes/Data Disk",
    ]);
  });

  it.each([
    [[{ Path: "C:\\", Capacity: 1000, FreeSpace: 200 }], ["C:\\"]],
    [
      [
        { Path: "C:\\", Capacity: 1000, FreeSpace: 200 },
        { Path: "C:\\Data\\", Capacity: 2000, FreeSpace: 1500 },
        { Path: "E:\\", Capacity: null, FreeSpace: null },
      ],
      ["C:\\", "C:\\Data\\"],
    ],
  ])("reports ready Windows volumes including folder-mounted storage: %j", async (rows, paths) => {
    mocks.platform.mockReturnValue("win32");
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: JSON.stringify(rows.length === 1 ? rows[0] : rows),
    });
    const { readSystemDisks } = await import("./system-disks.js");
    expect((await readSystemDisks())?.map((disk) => disk.path)).toEqual(paths);
  });

  it("shares in-flight probes and refreshes mount membership after the sample expires", async () => {
    vi.useFakeTimers();
    mocks.readFile.mockResolvedValue("1 0 8:1 / / rw - ext4 /dev/sda1 rw");
    const { readSystemDisks } = await import("./system-disks.js");
    const pending = readSystemDisks();
    expect(readSystemDisks()).toBe(pending);
    await pending;
    mocks.readFile.mockResolvedValue(
      "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:2 / /data rw - xfs /dev/sdb1 rw",
    );
    expect(await readSystemDisks()).toHaveLength(1);
    vi.advanceTimersByTime(10_001);
    expect(await readSystemDisks()).toHaveLength(2);
  });

  it("returns unavailable on probe failure and recovers on the next sample", async () => {
    vi.useFakeTimers();
    mocks.readFile.mockRejectedValueOnce(new Error("unavailable"));
    const { readSystemDisks } = await import("./system-disks.js");
    expect(await readSystemDisks()).toBeUndefined();
    mocks.readFile.mockResolvedValue("1 0 8:1 / / rw - ext4 /dev/sda1 rw");
    vi.advanceTimersByTime(10_001);
    expect(await readSystemDisks()).toHaveLength(1);
  });

  it("returns unavailable when df times out before printing its table", async () => {
    mocks.readFile.mockResolvedValue(
      "1 0 8:1 / / rw - ext4 /dev/sda1 rw\n2 1 8:2 / /data rw - xfs /dev/sdb1 rw",
    );
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 124,
      termination: "timeout",
      stdout: "",
    });
    const { readSystemDisks } = await import("./system-disks.js");
    expect(await readSystemDisks()).toBeUndefined();
  });
});
