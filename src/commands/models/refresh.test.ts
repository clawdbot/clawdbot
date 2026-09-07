import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../../cli/failure-output.js";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), getConfig: vi.fn(() => ({})) }));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.getConfig }));
vi.mock("../../model-catalog/remote-refresh.js", () => ({
  refreshRemoteModelCatalog: mocks.refresh,
}));

import { modelsRefreshCommand } from "./refresh.js";

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
  };
}

beforeEach(() => mocks.refresh.mockReset());

describe("models refresh", () => {
  it("prints updated, fresh, and disabled human results", async () => {
    const updatedRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({
      status: "updated",
      providers: 2,
      models: 3,
      generatedAt: 1_753_500_000_000,
    });
    await modelsRefreshCommand({}, updatedRuntime);
    expect(updatedRuntime.log).toHaveBeenLastCalledWith(
      "A running Gateway applies the updated catalog after its next restart.",
    );

    const freshRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({
      status: "fresh",
      providers: 2,
      models: 3,
      generatedAt: 1_753_500_000_000,
    });
    await modelsRefreshCommand({}, freshRuntime);
    expect(freshRuntime.log).toHaveBeenCalledWith(expect.stringContaining("refresh: fresh"));

    const disabledRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({ status: "disabled", providers: 0, models: 0 });
    await modelsRefreshCommand({}, disabledRuntime);
    expect(disabledRuntime.log).toHaveBeenCalledWith(
      "Remote catalog refresh is disabled (models.catalogRefresh.enabled=false)",
    );
  });

  it.each([
    { name: "human", options: {} },
    { name: "JSON", options: { json: true } },
  ])("delegates $name refresh failures to the canonical CLI error owner", async ({ options }) => {
    const commandRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({
      status: "error",
      providers: 0,
      models: 0,
      error: "boom",
    });

    const execution = modelsRefreshCommand(options, commandRuntime);

    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toMatchObject({
      message: "Remote catalog refresh failed: boom",
      humanOutput: "Remote catalog refresh failed: boom",
      machineOutput: "Remote catalog refresh failed: boom",
    });
    expect(commandRuntime.writeJson).not.toHaveBeenCalled();
    expect(commandRuntime.log).not.toHaveBeenCalled();
    expect(commandRuntime.error).not.toHaveBeenCalled();
    expect(commandRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: "updated",
      providers: 2,
      models: 3,
      generatedAt: 1_753_500_000_000,
    },
    {
      status: "unchanged",
      providers: 2,
      models: 3,
      generatedAt: 1_753_500_000_000,
    },
    {
      status: "fresh",
      providers: 2,
      models: 3,
      generatedAt: 1_753_500_000_000,
      nextCheckInMs: 1_000,
    },
    { status: "disabled", providers: 0, models: 0 },
  ])("preserves the $status JSON domain payload", async (result) => {
    const commandRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce(result);

    await modelsRefreshCommand({ json: true }, commandRuntime);

    expect(commandRuntime.writeJson).toHaveBeenCalledWith(result, 0);
    expect(commandRuntime.log).not.toHaveBeenCalled();
    expect(commandRuntime.error).not.toHaveBeenCalled();
    expect(commandRuntime.exit).not.toHaveBeenCalled();
  });
});
