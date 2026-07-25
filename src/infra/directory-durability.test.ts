import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireDirectorySync, syncDirectoryIfSupported } from "./directory-durability.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("directory durability compatibility", () => {
  it("accepts completed and unnecessary strict sync outcomes", () => {
    expect(() => requireDirectorySync({ status: "synced" }, "test directory")).not.toThrow();
    expect(() => requireDirectorySync({ status: "not-needed" }, "test directory")).not.toThrow();
  });

  it("rejects unsupported strict sync outcomes with their platform code", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(() =>
      requireDirectorySync({ status: "unsupported", code: "ENOTSUP" }, "test directory"),
    ).toThrow(
      /test directory does not support crash-durable directory synchronization \(ENOTSUP\)/u,
    );
  });

  it("accepts unsupported strict sync outcomes on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(() =>
      requireDirectorySync({ status: "unsupported", code: "EPERM" }, "test directory"),
    ).not.toThrow();
  });

  it.runIf(process.platform !== "win32")("reports a completed directory sync", async () => {
    const directoryPath = tempDirs.make("openclaw-directory-sync-");

    await expect(syncDirectoryIfSupported(directoryPath)).resolves.toEqual({ status: "synced" });
  });

  it.each(["EINVAL", "ENOSYS", "ENOTSUP"] as const)(
    "keeps the existing %s unsupported-filesystem compatibility",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const directoryPath = tempDirs.make("openclaw-directory-unsupported-");
      const originalOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        const handle = await originalOpen(filePath, flags, mode);
        vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error(code), { code }));
        return handle;
      });

      await expect(syncDirectoryIfSupported(directoryPath)).resolves.toEqual({
        status: "unsupported",
        code,
      });
    },
  );

  it("propagates real directory I/O failures", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const directoryPath = tempDirs.make("openclaw-directory-io-");
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      const handle = await originalOpen(filePath, flags, mode);
      vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error("I/O"), { code: "EIO" }));
      return handle;
    });

    await expect(syncDirectoryIfSupported(directoryPath)).rejects.toMatchObject({ code: "EIO" });
  });

  it.each(["EACCES", "EPERM"] as const)(
    "preserves Windows %s directory-open compatibility",
    async (code) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const directoryPath = tempDirs.make("openclaw-directory-windows-");
      vi.spyOn(fs, "open").mockRejectedValue(Object.assign(new Error(code), { code }));

      await expect(syncDirectoryIfSupported(directoryPath)).resolves.toEqual({
        status: "unsupported",
        code,
      });
    },
  );
});
