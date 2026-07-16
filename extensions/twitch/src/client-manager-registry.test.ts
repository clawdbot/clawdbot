// Twitch tests cover client manager registry plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getClientManager,
  getOrCreateClientManager,
  removeClientManager,
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
    await removeClientManager("default");
  });

  it("removes cached managers even when disconnectAll rejects", async () => {
    const firstManager = getOrCreateClientManager("default", makeLogger());
    const disconnectError = new Error("disconnect failed");
    const disconnectAll = vi
      .spyOn(firstManager, "disconnectAll")
      .mockRejectedValueOnce(disconnectError);

    await expect(removeClientManager("default")).rejects.toBe(disconnectError);

    expect(disconnectAll).toHaveBeenCalledOnce();
    expect(getClientManager("default")).toBeUndefined();
    expect(getOrCreateClientManager("default", makeLogger())).not.toBe(firstManager);
  });
});
