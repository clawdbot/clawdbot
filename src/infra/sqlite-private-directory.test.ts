import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const createPrivateDirectoryMock = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("./permissions.js", () => ({
  createPrivateDirectory: createPrivateDirectoryMock,
}));

import { createPrivateSqliteDirectory } from "./sqlite-private-directory.js";

afterEach(() => {
  vi.restoreAllMocks();
  createPrivateDirectoryMock.mockReset();
});

describe("createPrivateSqliteDirectory", () => {
  it("delegates Windows creation through the private-directory facade", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const directoryPath = path.resolve("private-sqlite-staging");
    createPrivateDirectoryMock.mockResolvedValue(undefined);

    await createPrivateSqliteDirectory(directoryPath);

    expect(createPrivateDirectoryMock).toHaveBeenCalledWith(path.toNamespacedPath(directoryPath));
  });

  it("preserves the EEXIST contract from native private-directory creation", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    createPrivateDirectoryMock.mockRejectedValue(
      Object.assign(new Error("native collision"), { code: "EEXIST" }),
    );

    await expect(createPrivateSqliteDirectory("private-sqlite-staging")).rejects.toMatchObject({
      code: "EEXIST",
    });
  });
});
