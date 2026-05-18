import { runDirectImportSmoke } from "openclaw/plugin-sdk/plugin-test-contracts";
import { beforeAll, describe, expect, it } from "vitest";

describe("irc bundled api seams", () => {
  let directSmokeStdout = "";

  beforeAll(async () => {
    directSmokeStdout = await runDirectImportSmoke(
      `const channel = await import("./extensions/irc/channel-plugin-api.ts");
const runtime = await import("./extensions/irc/runtime-api.ts");
process.stdout.write(JSON.stringify({
  channel: { keys: Object.keys(channel).sort(), id: channel.ircPlugin.id },
  runtime: { keys: Object.keys(runtime).sort(), type: typeof runtime.setIrcRuntime },
}));`,
    );
  }, 45_000);

  it("loads narrow public api modules in direct smoke", () => {
    expect(directSmokeStdout).toBe(
      '{"channel":{"keys":["ircPlugin"],"id":"irc"},"runtime":{"keys":["setIrcRuntime"],"type":"function"}}',
    );
  });
});
