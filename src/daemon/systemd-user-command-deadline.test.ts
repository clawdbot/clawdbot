// Direct and machine-scope attempts share the caller's one monotonic timeout.
import { afterEach, describe, expect, it, vi } from "vitest";
const exec = vi.hoisted(() => vi.fn<typeof import("./exec-file.js").execFileUtf8>());
vi.mock("./exec-file.js", () => ({ execFileUtf8: exec }));
import { execBusctlUser, execSystemctlUser } from "./systemd-exec.js";

afterEach(() => vi.restoreAllMocks());

describe("systemd user routing deadline", () => {
  it.each([450, 500])("does not give fallback a new deadline after %s ms", async (spent) => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(process, "geteuid").mockReturnValue(1001);
    exec.mockReset().mockImplementation(async (_command, args) => {
      if (!args.includes("--machine")) {
        elapsed += spent;
        return {
          code: 1,
          termination: "exit",
          stdout: "",
          stderr: "Failed to connect to bus: No medium found",
        };
      }
      return { code: 0, termination: "exit", stdout: "native result", stderr: "" };
    });
    const result = await execBusctlUser(
      {
        USER: "owned",
        LOGNAME: "owned",
        HOME: "/test/owned",
        XDG_RUNTIME_DIR: "/run/user/1001",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
      },
      ["--auto-start=no", "--json=short", "call", "org.freedesktop.systemd1"],
      500,
    );
    expect(exec.mock.calls[0]?.[2]?.timeout).toBe(500);
    if (spent === 450) {
      expect(exec).toHaveBeenCalledTimes(2);
      expect(exec.mock.calls[1]?.[1]).toContain("owned@");
      expect(exec.mock.calls[1]?.[2]?.timeout).toBe(50);
      expect(result.code).toBe(0);
    } else {
      expect(exec).toHaveBeenCalledTimes(1);
      expect(result.termination).toBe("timeout");
      expect(result.code).not.toBe(0);
    }
  });
});

it("does not dispatch machine fallback after the original stop owner retires", async () => {
  let active = true;
  vi.spyOn(process, "geteuid").mockReturnValue(1001);
  exec.mockReset().mockImplementation(async () => {
    active = false;
    return {
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: "Failed to connect to bus: No medium found",
    };
  });
  await expect(
    execSystemctlUser(
      { USER: "owned", HOME: "/test/owned" },
      ["stop", "openclaw-gateway.service"],
      500,
      () => {
        if (!active) {
          throw new Error("original stop owner retired");
        }
      },
    ),
  ).rejects.toThrow("original stop owner retired");
  expect(exec).toHaveBeenCalledTimes(1);
});
