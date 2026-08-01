// Successful Gateway-backed channel status must not load local plugin/config runtime work.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModuleLoaded = vi.hoisted(() => vi.fn());
const callGatewayMock = vi.hoisted(() => vi.fn(async () => ({ channelAccounts: {} })));

vi.mock("./channels/status.runtime.js", () => {
  runtimeModuleLoaded();
  return {
    formatGatewayChannelsStatusLines: vi.fn(() => []),
    renderChannelsStatusFallback: vi.fn(async () => {}),
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: vi.fn(async (_opts, run: () => Promise<unknown>) => await run()),
}));

import { channelsStatusCommand } from "./channels/status.js";

describe("channelsStatusCommand cold imports", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
    runtimeModuleLoaded.mockClear();
  });

  it.each([false, true])(
    "keeps a successful JSON gateway request cold when probe=%s",
    async (probe) => {
      const runtime = {
        error: vi.fn(),
        exit: vi.fn(),
        log: vi.fn(),
        writeJson: vi.fn(),
        writeStdout: vi.fn(),
      };

      await channelsStatusCommand({ json: true, probe }, runtime);

      expect(callGatewayMock).toHaveBeenCalledOnce();
      expect(runtime.writeJson).toHaveBeenCalledWith({ channelAccounts: {} }, 2);
      expect(runtimeModuleLoaded).not.toHaveBeenCalled();
    },
  );
});
