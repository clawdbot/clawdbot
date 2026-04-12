import { describe, expect, it } from "vitest";
import { runDirectImportSmoke } from "../../test/helpers/plugins/direct-smoke.js";

describe("irc bundled api seams", () => {
  it("loads the narrow channel plugin api in direct smoke", async () => {
    const stdout = await runDirectImportSmoke(
      'const mod = await import("./extensions/irc/channel-plugin-api.ts"); process.stdout.write(JSON.stringify({keys:Object.keys(mod).sort(), id: mod.ircPlugin.id}));',
    );

    expect(stdout).toBe('{"keys":["ircPlugin"],"id":"irc"}');
  }, 45_000);

  it("loads the narrow runtime api in direct smoke", async () => {
    const stdout = await runDirectImportSmoke(
      'const mod = await import("./extensions/irc/runtime-api.ts"); process.stdout.write(JSON.stringify({keys:Object.keys(mod).sort(), type: typeof mod.setIrcRuntime}));',
    );

    expect(stdout).toBe('{"keys":["setIrcRuntime"],"type":"function"}');
  }, 45_000);
});
