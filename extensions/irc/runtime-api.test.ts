import { describe, expect, it } from "vitest";
import { runDirectImportSmoke } from "../../test/helpers/plugins/direct-smoke.js";

describe("irc bundled api seams", () => {
  it("loads narrow public api modules in direct smoke", async () => {
    const stdout = await runDirectImportSmoke(
      `const channel = await import("./extensions/irc/channel-plugin-api.ts");
const runtime = await import("./extensions/irc/runtime-api.ts");
process.stdout.write(JSON.stringify({
  channel: { keys: Object.keys(channel).sort(), id: channel.ircPlugin.id },
  runtime: { keys: Object.keys(runtime).sort(), type: typeof runtime.setIrcRuntime },
}));`,
    );

    expect(stdout).toBe(
      '{"channel":{"keys":["ircPlugin"],"id":"irc"},"runtime":{"keys":["setIrcRuntime"],"type":"function"}}',
    );
  }, 45_000);
});
