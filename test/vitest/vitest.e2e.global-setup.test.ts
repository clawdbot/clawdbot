import { describe, expect, it, vi } from "vitest";
import { runE2eGlobalSetup } from "./vitest.e2e.global-setup.js";

type ManagedCommandRunner = NonNullable<Parameters<typeof runE2eGlobalSetup>[0]>;

describe("vitest E2E global setup", () => {
  it("streams both sequential build commands without a local timeout", async () => {
    let finishFirst: (status: number) => void = () => {};
    const firstCommand = new Promise<number>((resolve) => {
      finishFirst = resolve;
    });
    const runCommand = vi
      .fn<ManagedCommandRunner>()
      .mockImplementationOnce(() => firstCommand)
      .mockResolvedValueOnce(0);

    const setupPromise = runE2eGlobalSetup(runCommand);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));

    const firstOptions = runCommand.mock.calls[0]?.[0];
    expect(firstOptions).toEqual({
      args: ["scripts/run-node.mjs", "--version"],
      bin: process.execPath,
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_BUILD_PRIVATE_QA: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
      },
      stdio: "inherit",
    });
    expect(firstOptions).not.toHaveProperty("timeoutMs");
    expect(runCommand).toHaveBeenCalledTimes(1);

    finishFirst(0);
    await setupPromise;

    const secondOptions = runCommand.mock.calls[1]?.[0];
    expect(secondOptions).toEqual({
      args: ["scripts/tsdown-build.mjs", "--config", "tsdown.ai.config.ts"],
      bin: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    expect(secondOptions).not.toHaveProperty("timeoutMs");
  });

  it.each([
    {
      calls: 1,
      statuses: [17],
      command: "scripts/run-node.mjs --version",
    },
    {
      calls: 2,
      statuses: [0, 23],
      command: "scripts/tsdown-build.mjs --config tsdown.ai.config.ts",
    },
  ])("propagates a nonzero status from $command", async ({ calls, statuses, command }) => {
    const runCommand = vi.fn<ManagedCommandRunner>();
    for (const status of statuses) {
      runCommand.mockResolvedValueOnce(status);
    }

    await expect(runE2eGlobalSetup(runCommand)).rejects.toThrow(
      `E2E setup command failed with exit code ${statuses.at(-1)}: ${command}`,
    );
    expect(runCommand).toHaveBeenCalledTimes(calls);
  });
});
