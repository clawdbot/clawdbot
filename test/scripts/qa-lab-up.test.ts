// Qa Lab Up tests cover qa lab up script behavior.
import { describe, expect, it, vi } from "vitest";
import { qaLabUpTesting } from "../../scripts/qa-lab-up.js";

describe("scripts/qa-lab-up", () => {
  it("prints help before loading the Docker runtime", async () => {
    const loadRuntime = vi.fn(async () => {
      throw new Error("runtime loaded");
    });
    const writeStdout = vi.fn();

    await expect(
      qaLabUpTesting.runQaLabUp(["--help"], {
        loadRuntime,
        writeStdout,
      }),
    ).resolves.toBe(0);

    expect(loadRuntime).not.toHaveBeenCalled();
    expect(writeStdout).toHaveBeenCalledWith(expect.stringContaining("Usage: pnpm qa:lab:up"));
  });

  it("loads the Docker runtime only for non-help runs", async () => {
    const runQaDockerUpCommand = vi.fn(async () => {});
    const loadRuntime = vi.fn(async () => ({ runQaDockerUpCommand }));

    await expect(
      qaLabUpTesting.runQaLabUp(["--gateway-port", "4100"], { loadRuntime }),
    ).resolves.toBe(0);

    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(runQaDockerUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 4100 }),
    );
  });

  it("accepts the pnpm run argument separator", async () => {
    const runQaDockerUpCommand = vi.fn(async () => {});
    const loadRuntime = vi.fn(async () => ({ runQaDockerUpCommand }));

    await expect(
      qaLabUpTesting.runQaLabUp(["--", "--gateway-port", "4100"], { loadRuntime }),
    ).resolves.toBe(0);

    expect(runQaDockerUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 4100 }),
    );
  });

  it("accepts the maximum TCP port before loading the Docker runtime", async () => {
    const runQaDockerUpCommand = vi.fn(async () => {});
    const loadRuntime = vi.fn(async () => ({ runQaDockerUpCommand }));

    await expect(
      qaLabUpTesting.runQaLabUp(["--gateway-port", "65535", "--qa-lab-port", "65535"], {
        loadRuntime,
      }),
    ).resolves.toBe(0);

    expect(runQaDockerUpCommand).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 65535, qaLabPort: 65535 }),
    );
  });

  it.each([
    [["--gateway-port", ""], "--gateway-port must be a positive integer."],
    [["--gateway-port", "1.5"], "--gateway-port must be a positive integer."],
    [["--gateway-port", "0x1000"], "--gateway-port must be a positive integer."],
    [["--gateway-port", "0"], "--gateway-port must be a positive integer."],
    [["--gateway-port", "65536"], "--gateway-port must be a TCP port from 1 to 65535."],
    [["--qa-lab-port", ""], "--qa-lab-port must be a positive integer."],
    [["--qa-lab-port", "1e4"], "--qa-lab-port must be a positive integer."],
    [["--qa-lab-port", "65536"], "--qa-lab-port must be a TCP port from 1 to 65535."],
  ])("rejects invalid TCP ports: %j", async (args, errorMessage) => {
    const loadRuntime = vi.fn(async () => ({ runQaDockerUpCommand: vi.fn(async () => {}) }));

    await expect(qaLabUpTesting.runQaLabUp(args, { loadRuntime })).rejects.toThrow(errorMessage);

    expect(loadRuntime).not.toHaveBeenCalled();
  });
});
