import { beforeEach, describe, expect, it, vi } from "vitest";
import { runExec } from "../process/exec.js";
import { readSystemdUserLingerStatus } from "./systemd.js";

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
  runCommandWithTimeout: vi.fn(),
}));

const runExecMock = vi.mocked(runExec);

describe("readSystemdUserLingerStatus", () => {
  beforeEach(() => {
    runExecMock.mockReset();
  });

  it("returns yes when loginctl reports Linger=yes", async () => {
    runExecMock.mockResolvedValue({
      stdout: "Linger=yes\n",
      stderr: "",
    });
    const result = await readSystemdUserLingerStatus({ USER: "tobi" });
    expect(result).toEqual({ user: "tobi", linger: "yes" });
  });

  it("returns no when loginctl reports Linger=no", async () => {
    runExecMock.mockResolvedValue({
      stdout: "Linger=no\n",
      stderr: "",
    });
    const result = await readSystemdUserLingerStatus({ USER: "tobi" });
    expect(result).toEqual({ user: "tobi", linger: "no" });
  });

  it("returns null when Linger is missing", async () => {
    runExecMock.mockResolvedValue({
      stdout: "UID=1000\n",
      stderr: "",
    });
    const result = await readSystemdUserLingerStatus({ USER: "tobi" });
    expect(result).toBeNull();
  });
});
