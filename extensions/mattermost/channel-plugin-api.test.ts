import { describe, expect, it } from "vitest";
import { runDirectImportSmoke } from "../../test/helpers/plugins/direct-smoke.js";

describe("mattermost bundled api seam", () => {
  it("loads the narrow channel plugin api in direct smoke", async () => {
    const stdout = await runDirectImportSmoke(
      'const mod = await import("./extensions/mattermost/channel-plugin-api.ts"); process.stdout.write(JSON.stringify({keys:Object.keys(mod).sort(), id: mod.mattermostPlugin.id, setupId: mod.mattermostSetupPlugin.id}));',
    );

    expect(stdout).toBe(
      '{"keys":["mattermostPlugin","mattermostSetupPlugin"],"id":"mattermost","setupId":"mattermost"}',
    );
  }, 45_000);
});
