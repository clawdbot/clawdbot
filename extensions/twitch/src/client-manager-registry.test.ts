import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRegistryForTest,
  getClientManager,
  getOrCreateClientManager,
} from "./client-manager-registry.js";
import type { ChannelLogSink } from "./types.js";

function makeLogger(): ChannelLogSink {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("client manager registry", () => {
  afterEach(async () => {
    await clearRegistryForTest();
  });

  it("clears cached managers for hot module test isolation", async () => {
    const firstManager = getOrCreateClientManager("default", makeLogger());
    const disconnectAll = vi.spyOn(firstManager, "disconnectAll");

    expect(getClientManager("default")).toBe(firstManager);
    expect(getOrCreateClientManager("default", makeLogger())).toBe(firstManager);

    await clearRegistryForTest();

    expect(disconnectAll).toHaveBeenCalledOnce();
    expect(getClientManager("default")).toBeUndefined();
    expect(getOrCreateClientManager("default", makeLogger())).not.toBe(firstManager);
  });
});
