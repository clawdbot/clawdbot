import { afterEach, describe, expect, it } from "vitest";
import { configureCodexRealtimeBrowserSession } from "./realtime-voice-api.js";

const leases: Array<ReturnType<typeof configureCodexRealtimeBrowserSession>> = [];

const createRuntime = () => {
  const runtime = configureCodexRealtimeBrowserSession({
    getConfig: () => undefined,
    getPluginConfig: () => undefined,
  });
  leases.push(runtime);
  return runtime;
};

describe("Codex realtime voice runtime artifact", () => {
  afterEach(async () => {
    await Promise.all(leases.splice(0).map((runtime) => runtime.cleanup()));
  });

  it("shares one owner runtime across registration leases", async () => {
    const first = createRuntime();
    const second = createRuntime();

    expect(second).not.toBe(first);
    expect(second.broker).toBe(first.broker);

    await first.cleanup();
    await second.cleanup();
  });

  it("reads config from the newest active registration", () => {
    let firstConfigReads = 0;
    let secondConfigReads = 0;
    const first = configureCodexRealtimeBrowserSession({
      getConfig: () => {
        firstConfigReads += 1;
        return undefined;
      },
      getPluginConfig: () => undefined,
    });
    const second = configureCodexRealtimeBrowserSession({
      getConfig: () => {
        secondConfigReads += 1;
        return undefined;
      },
      getPluginConfig: () => undefined,
    });
    leases.push(first, second);

    expect(second.broker.isConfigured()).toBe(false);
    expect(firstConfigReads).toBe(0);
    expect(secondConfigReads).toBe(1);
  });
});
