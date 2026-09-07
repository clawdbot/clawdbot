import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getPublishFileExclusiveFailureDetails,
  publishFileNoClobber,
  requireDirectorySync,
  syncDirectoryIfSupported,
} from "./directory-durability.js";

type PublishFileExclusive = typeof import("@openclaw/fs-safe/durability").publishFileExclusive;
type PublishedFile = Awaited<ReturnType<PublishFileExclusive>>;
type AfterPublish = (
  params: Parameters<PublishFileExclusive>[0],
  result: PublishedFile,
) => Promise<PublishedFile>;

const durabilityTestState = vi.hoisted(() => ({
  afterPublish: undefined as AfterPublish | undefined,
  publishSyncOutcome: undefined as
    | { status: "synced" }
    | { status: "unsupported"; code?: string }
    | undefined,
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    publishFileExclusive: async (...args: Parameters<typeof actual.publishFileExclusive>) => {
      const published = await actual.publishFileExclusive(...args);
      const result = durabilityTestState.afterPublish
        ? await durabilityTestState.afterPublish(args[0], published)
        : published;
      return durabilityTestState.publishSyncOutcome
        ? { ...result, directorySync: durabilityTestState.publishSyncOutcome }
        : result;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  durabilityTestState.afterPublish = undefined;
  durabilityTestState.publishSyncOutcome = undefined;
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

  it.runIf(process.platform !== "win32")(
    "preserves its target with a receipt when fail-closed durability rejects",
    async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const directoryPath = tempDirs.make("openclaw-publish-cleanup-");
      const sourcePath = path.join(directoryPath, "source.txt");
      const targetPath = path.join(directoryPath, "target.txt");
      await fs.writeFile(sourcePath, "complete publication");
      durabilityTestState.publishSyncOutcome = { status: "unsupported", code: "ENOTSUP" };

      const error = await publishFileNoClobber(sourcePath, targetPath, {
        strategy: "link-or-copy",
        durability: "fail-closed",
      }).catch((caught: unknown) => caught);

      expect(getPublishFileExclusiveFailureDetails(error)).toMatchObject({
        phase: "directory-sync",
        targetCreated: true,
        cleanup: "preserved",
      });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("complete publication");
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("complete publication");
    },
  );

  it("removes a source only after its published target passes the ownership fence", async () => {
    const directoryPath = tempDirs.make("openclaw-publish-move-");
    const sourcePath = path.join(directoryPath, "source.txt");
    const targetPath = path.join(directoryPath, "target.txt");
    await fs.writeFile(sourcePath, "complete publication");

    await expect(
      publishFileNoClobber(sourcePath, targetPath, {
        strategy: "link-or-copy",
        moveSource: true,
        durability: "fail-closed",
      }),
    ).resolves.toMatchObject({ method: "hardlink" });
    await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("complete publication");
  });

  it.each([false, true])(
    "rejects a recycled publication identity without removing the source (moveSource=%s)",
    async (moveSource) => {
      const directoryPath = tempDirs.make("openclaw-publish-identity-reuse-");
      const sourcePath = path.join(directoryPath, "source.txt");
      const targetPath = path.join(directoryPath, "target.txt");
      const displacedPath = path.join(directoryPath, "target.displaced.txt");
      await fs.writeFile(sourcePath, "complete publication");
      durabilityTestState.afterPublish = async (params, published) => {
        if (path.resolve(params.targetPath) !== targetPath) {
          return published;
        }
        await fs.rename(targetPath, displacedPath);
        await fs.writeFile(targetPath, "racer");
        // Reproduce the Windows failure mode where the dependency accepts a
        // recycled identity and reports the replacement as its published file.
        return { ...published, identity: await fs.lstat(targetPath) };
      };

      const error = await publishFileNoClobber(sourcePath, targetPath, {
        strategy: "link-or-copy",
        moveSource,
        durability: "fail-closed",
      }).catch((caught: unknown) => caught);

      expect(getPublishFileExclusiveFailureDetails(error)).toMatchObject({
        phase: "hardlink-verify",
        targetCreated: true,
        cleanup: "preserved",
      });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe("complete publication");
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("racer");
      await expect(fs.readFile(displacedPath, "utf8")).resolves.toBe("complete publication");
    },
  );

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
