import { beforeEach, describe, expect, it, vi } from "vitest";

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
  it("prints updated, fresh, disabled, error, and JSON results", async () => {
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

    const errorRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({
      status: "error",
      providers: 0,
      models: 0,
      error: "boom",
    });
    await modelsRefreshCommand({}, errorRuntime);
    expect(errorRuntime.error).toHaveBeenCalledWith("Remote catalog refresh failed: boom");
    expect(errorRuntime.exit).toHaveBeenCalledWith(1);

    const jsonRuntime = runtime();
    mocks.refresh.mockResolvedValueOnce({ status: "disabled", providers: 0, models: 0 });
    await modelsRefreshCommand({ json: true }, jsonRuntime);
    expect(jsonRuntime.writeJson).toHaveBeenCalledWith(
      { status: "disabled", providers: 0, models: 0 },
      0,
    );
    expect(jsonRuntime.log).not.toHaveBeenCalled();
  });

  it("writes refresh errors to structured stdout before exiting in JSON mode", async () => {
    const jsonRuntime = runtime();
    const result = { status: "error", providers: 0, models: 0, error: "boom" };
    mocks.refresh.mockResolvedValueOnce(result);

    await modelsRefreshCommand({ json: true }, jsonRuntime);

    expect(jsonRuntime.writeJson).toHaveBeenCalledWith(result, 0);
    expect(jsonRuntime.exit).toHaveBeenCalledWith(1);
    expect(jsonRuntime.log).not.toHaveBeenCalled();
    expect(jsonRuntime.error).not.toHaveBeenCalled();
  });
});
