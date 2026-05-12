import { describe, expect, it } from "vitest";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";

describe("collectRuntimeChannelCapabilities", () => {
  it("adds thread-bound spawn capabilities when the channel account allows unified spawns", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: true,
            },
          },
        },
      },
    });

    expect(capabilities).toEqual(["threadbound-subagent-spawn", "threadbound-acp-spawn"]);
  });

  it("omits thread-bound spawn capabilities when unified spawns are disabled", () => {
    const capabilities = collectRuntimeChannelCapabilities({
      channel: "discord",
      accountId: "default",
      cfg: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: false,
            },
          },
        },
      },
    });

    expect(capabilities).toBeUndefined();
  });
});
