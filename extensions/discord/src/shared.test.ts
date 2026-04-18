import { describe, expect, it } from "vitest";
import { createDiscordPluginBase } from "./shared.js";

describe("createDiscordPluginBase", () => {
  it("owns Discord native command name overrides", () => {
    const plugin = createDiscordPluginBase({ setup: {} as never });

    expect(
      plugin.commands?.resolveNativeCommandName?.({
        commandKey: "tts",
        defaultName: "tts",
      }),
    ).toBe("voice");
    expect(
      plugin.commands?.resolveNativeCommandName?.({
        commandKey: "status",
        defaultName: "status",
      }),
    ).toBe("status");
  });
});
