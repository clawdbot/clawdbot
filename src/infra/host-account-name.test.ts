import fs from "node:fs/promises";
import os from "node:os";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", () => ({ runExec: runExecMock }));

let resolveHostAccountName: typeof import("./host-account-name.js").resolveHostAccountName;
let freshModuleId = 0;

beforeEach(async () => {
  ({ resolveHostAccountName } = await importFreshModule<typeof import("./host-account-name.js")>(
    import.meta.url,
    `./host-account-name.js?test=${freshModuleId++}`,
  ));
  vi.spyOn(os, "userInfo").mockReturnValue({
    username: "ada",
    uid: 1000,
    gid: 1000,
    homedir: "/home/ada",
    shell: "/bin/sh",
  });
});

afterEach(() => {
  runExecMock.mockReset();
  vi.restoreAllMocks();
});

describe("resolveHostAccountName", () => {
  it("trims the macOS full name and shares one lookup across concurrent callers", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    runExecMock.mockResolvedValue({ stdout: "  Ada Lovelace \n", stderr: "" });

    expect(await Promise.all([resolveHostAccountName(), resolveHostAccountName()])).toEqual([
      "Ada Lovelace",
      "Ada Lovelace",
    ]);
    await expect(resolveHostAccountName()).resolves.toBe("Ada Lovelace");
    expect(runExecMock).toHaveBeenCalledOnce();
    expect(runExecMock).toHaveBeenCalledWith("/usr/bin/id", ["-F"], expect.any(Object));
  });

  it.each(["RealName: Ada Lovelace\n", "RealName:\n Ada Lovelace\n"])(
    "reads a macOS directory full name after id fails: %s",
    async (stdout) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      runExecMock
        .mockRejectedValueOnce(new Error("id failed"))
        .mockResolvedValueOnce({ stdout, stderr: "" });

      await expect(resolveHostAccountName()).resolves.toBe("Ada Lovelace");
      expect(runExecMock).toHaveBeenLastCalledWith(
        "/usr/bin/dscl",
        [".", "-read", "/Users/ada", "RealName"],
        expect.any(Object),
      );
    },
  );

  it.each([
    { gecos: " Ada Lovelace ,Room 42,555-0100", expected: "Ada Lovelace" },
    { gecos: ",Room 42", expected: null },
    { gecos: "", expected: null },
    { gecos: "ada", expected: null },
    { gecos: "A".repeat(300), expected: "A".repeat(256) },
  ])("uses only a bounded human name from Linux GECOS: $gecos", async ({ gecos, expected }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExecMock.mockResolvedValue({
      stdout: `ada:x:1000:1000:${gecos}:/home/ada:/bin/sh\n`,
      stderr: "",
    });

    await expect(resolveHostAccountName()).resolves.toBe(expected);
    expect(runExecMock).toHaveBeenCalledWith("getent", ["passwd", "ada"], expect.any(Object));
  });

  it("selects the host account from passwd when getent is unavailable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExecMock.mockRejectedValue(new Error("getent unavailable"));
    const readFile = vi
      .spyOn(fs, "readFile")
      .mockResolvedValue(
        "root:x:0:0:root:/root:/bin/sh\nada:x:1000:1000:Ada Lovelace,Room 42:/home/ada:/bin/sh\n",
      );

    await expect(resolveHostAccountName()).resolves.toBe("Ada Lovelace");
    expect(readFile).toHaveBeenCalledWith("/etc/passwd", "utf8");
  });

  it("bounds subprocess timeouts and caches lookup failure without throwing", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    runExecMock.mockRejectedValue(Object.assign(new Error("timed out"), { timedOut: true }));

    await expect(resolveHostAccountName()).resolves.toBeNull();
    await expect(resolveHostAccountName()).resolves.toBeNull();
    expect(runExecMock).toHaveBeenCalledTimes(2);
    for (const call of runExecMock.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: 1000, logOutput: false });
    }
  });

  it("does not replace a missing full name with the macOS login", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    runExecMock
      .mockResolvedValueOnce({ stdout: "ada\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "RealName:\n", stderr: "" });

    await expect(resolveHostAccountName()).resolves.toBeNull();
  });

  it("ignores unavailable OS account metadata and unreadable passwd files", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExecMock.mockRejectedValue(new Error("getent unavailable"));
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("permission denied"));

    await expect(resolveHostAccountName()).resolves.toBeNull();
  });

  it.each(["win32", "freebsd"] as const)("returns no name on %s", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);

    await expect(resolveHostAccountName()).resolves.toBeNull();
    expect(runExecMock).not.toHaveBeenCalled();
    expect(os.userInfo).not.toHaveBeenCalled();
  });
});
