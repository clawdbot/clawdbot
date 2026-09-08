import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectLlamaCppHardware } from "./hardware.js";

const probes = vi.hoisted(() => ({
  output: "",
  error: undefined as Error | undefined,
  diskContainers: {} as Record<string, string>,
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const output =
        _file === "/bin/df"
          ? `/dev/${_args[1] === "/models" ? "disk4s1" : "disk5s1"} 100 50 50 50% /volume`
          : _file === "/usr/sbin/diskutil"
            ? (probes.diskContainers[_args[2] ?? ""] ?? "")
            : probes.output;
      callback(probes.error ?? null, output, "");
    },
  ),
}));

const GIB = 1024 ** 3;
const readStat = fs.stat;
const disk = {
  type: 0xef53,
  bsize: 4096,
  frsize: 4096,
  blocks: 100,
  bfree: 50,
  bavail: 40,
  files: 100,
  ffree: 50,
};

beforeEach(async () => {
  probes.output = "";
  probes.error = undefined;
  probes.diskContainers = {};
  vi.spyOn(os, "platform").mockReturnValue("linux");
  vi.spyOn(os, "arch").mockReturnValue("x64");
  vi.spyOn(os, "totalmem").mockReturnValue(32 * GIB);
  vi.spyOn(os, "freemem").mockReturnValue(4 * GIB);
  vi.spyOn(process, "constrainedMemory").mockReturnValue(0);
  vi.spyOn(process, "availableMemory").mockReturnValue(4 * GIB);
  vi.spyOn(fs, "readFile").mockResolvedValue("MemAvailable:   16777216 kB\n");
  vi.spyOn(fs, "statfs").mockResolvedValue(disk);
  vi.spyOn(fs, "stat").mockResolvedValue(await fs.stat(os.tmpdir()));
});

afterEach(() => vi.restoreAllMocks());

describe("Gateway hardware detection", () => {
  it("uses the Gateway container budget instead of the physical host capacity", async () => {
    vi.spyOn(process, "constrainedMemory").mockReturnValue(8 * GIB);
    vi.spyOn(process, "availableMemory").mockReturnValue(3 * GIB);

    expect(await detectLlamaCppHardware({ cacheDir: "/models" })).toMatchObject({
      totalMemoryBytes: 8 * GIB,
      availableMemoryBytes: 3 * GIB,
    });
  });

  it("reports reclaimable Linux memory and separate NVIDIA device budgets", async () => {
    probes.output = [
      "NVIDIA Device A, 24576, 20000, 580.65.06, 8.9",
      "NVIDIA Device B, 8192, 4096, 580.65.06, 7.5",
    ].join("\n");

    const hardware = await detectLlamaCppHardware({ cacheDir: "/models" });

    expect(hardware).toMatchObject({
      totalMemoryBytes: 32 * GIB,
      availableMemoryBytes: 16 * GIB,
      availableDiskBytes: 40 * 4096,
      availableRuntimeDiskBytes: 40 * 4096,
      sharedDisk: true,
      accelerator: {
        kind: "cuda",
        devices: [
          {
            totalMemoryBytes: 24 * GIB,
            availableMemoryBytes: 20000 * 1024 ** 2,
            computeCapability: 8.9,
          },
          { totalMemoryBytes: 8 * GIB, availableMemoryBytes: 4 * GIB, computeCapability: 7.5 },
        ],
      },
    });
  });

  it("counts reclaimable Apple memory once and identifies unified Metal", async () => {
    vi.mocked(os.platform).mockReturnValue("darwin");
    vi.mocked(os.arch).mockReturnValue("arm64");
    probes.output = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free: 65536.",
      "Pages inactive: 131072.",
      "Pages purgeable: 32768.",
    ].join("\n");

    const hardware = await detectLlamaCppHardware({ cacheDir: "/models" });

    expect(hardware.availableMemoryBytes).toBe(3 * GIB);
    expect(hardware.accelerator).toEqual({ kind: "metal" });
  });

  it("reports separate capacities when the model cache is on another volume", async () => {
    const cacheStat = await readStat(os.tmpdir());
    cacheStat.dev += 1;
    vi.mocked(fs.stat).mockResolvedValueOnce(cacheStat);
    vi.mocked(fs.statfs)
      .mockResolvedValueOnce(disk)
      .mockResolvedValueOnce({ ...disk, bavail: 5 });

    expect(await detectLlamaCppHardware({ cacheDir: "/models" })).toMatchObject({
      availableDiskBytes: 40 * 4096,
      availableRuntimeDiskBytes: 5 * 4096,
      sharedDisk: false,
    });
  });

  it.each([0x9123683e, 0x794c7630, 0x2fc12fc1])(
    "reserves combined capacity for pooled or layered Linux filesystems: %s",
    async (type) => {
      const cacheStat = await readStat(os.tmpdir());
      cacheStat.dev += 1;
      vi.mocked(fs.stat).mockResolvedValueOnce(cacheStat);
      vi.mocked(fs.statfs).mockResolvedValue({ ...disk, type });

      expect((await detectLlamaCppHardware({ cacheDir: "/models" })).sharedDisk).toBe(true);
    },
  );

  it.each([
    { runtimeContainer: "disk4", sharedDisk: true },
    { runtimeContainer: "disk5", sharedDisk: false },
    { runtimeContainer: undefined, sharedDisk: true },
  ])(
    "accounts for APFS shared capacity: $runtimeContainer",
    async ({ runtimeContainer, sharedDisk }) => {
      vi.mocked(os.platform).mockReturnValue("darwin");
      const cacheStat = await readStat(os.tmpdir());
      cacheStat.dev += 1;
      vi.mocked(fs.stat).mockResolvedValueOnce(cacheStat);
      probes.diskContainers = {
        disk4s1: "<key>APFSContainerReference</key><string>disk4</string>",
        ...(runtimeContainer
          ? { disk5s1: `<key>APFSContainerReference</key><string>${runtimeContainer}</string>` }
          : {}),
      };

      expect((await detectLlamaCppHardware({ cacheDir: "/models" })).sharedDisk).toBe(sharedDisk);
    },
  );

  it.each([
    { name: "missing driver", output: "", error: new Error("ENOENT") },
    {
      name: "invalid telemetry",
      output: "NVIDIA Device, N/A, 4096, 580.65.06, 8.9",
      error: undefined,
    },
  ])("reports a CPU reason for $name without inventing GPU capacity", async ({ output, error }) => {
    probes.output = output;
    probes.error = error;

    const hardware = await detectLlamaCppHardware({ cacheDir: "/models" });

    expect(hardware.accelerator).toMatchObject({ kind: "cpu", reason: expect.any(String) });
  });

  it("checks the nearest existing cache ancestor without creating directories", async () => {
    vi.mocked(fs.statfs).mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );

    const hardware = await detectLlamaCppHardware({ cacheDir: "/models/new" });

    expect(hardware.availableDiskBytes).toBe(40 * 4096);
    expect(fs.statfs).toHaveBeenLastCalledWith("/models");
  });

  it("keeps unreadable disk capacity unknown", async () => {
    vi.mocked(fs.statfs).mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));

    expect(
      (await detectLlamaCppHardware({ cacheDir: "/models" })).availableDiskBytes,
    ).toBeUndefined();
  });

  it("honors setup cancellation before probing", async () => {
    await expect(
      detectLlamaCppHardware({ cacheDir: "/models", signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(fs.statfs).not.toHaveBeenCalled();
  });
});
