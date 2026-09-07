// Irc tests cover runtime api plugin behavior.
import { runDirectImportSmoke } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it } from "vitest";

describe("irc bundled api seams", () => {
  let directSmokeStdout = "";

  beforeAll(async () => {
    directSmokeStdout = await runDirectImportSmoke(
      `import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const loadModule = process.versions.bun
  ? (await import("./scripts/lib/import-tooling-typescript.mts")).importToolingTypeScript
  : (url) => import(url);
const channel = await loadModule(
  pathToFileURL(resolve("./extensions/irc/channel-plugin-api.ts")).href, import.meta.url,
);
const runtime = await loadModule(
  pathToFileURL(resolve("./extensions/irc/runtime-api.ts")).href, import.meta.url,
);
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
