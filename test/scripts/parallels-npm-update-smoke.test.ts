import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/e2e/parallels/npm-update-smoke.ts";
const UPDATE_SCRIPTS_PATH = "scripts/e2e/parallels/npm-update-scripts.ts";

describe("parallels npm update smoke", () => {
  it("does not leave guard/server children attached to the wrapper", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("spawnLogged");
    expect(script).toContain('child.on("close"');
    expect(script).toContain("await this.server?.stop()");
  });

  it("runs Windows updates through a detached done-file runner", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("openclaw-parallels-npm-update-windows");
    expect(script).toContain("runStreaming");
    expect(script).toContain("__OPENCLAW_BACKGROUND_EXIT__");
    expect(script).toContain("__OPENCLAW_BACKGROUND_DONE__");
    expect(script).toContain("Windows update timed out");
  });

  it("keeps macOS sudo fallback update scripts readable by the desktop user", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain('macosExecArgs.indexOf("-u")');
    expect(script).toContain('"/usr/sbin/chown", sudoUser, scriptPath');
  });

  it("scrubs future plugin entries before invoking old same-guest updaters", () => {
    const script = readFileSync(UPDATE_SCRIPTS_PATH, "utf8");

    expect(script).toContain("Remove-FuturePluginEntries");
    expect(script).toContain("scrub_future_plugin_entries");
    expect(script).toContain("delete plugins.entries.feishu");
    expect(script).toContain("delete plugins.entries.whatsapp");
    expect(script).toContain("Remove-FuturePluginEntries\nStop-OpenClawGatewayProcesses");
    expect(script).toContain("scrub_future_plugin_entries\nstop_openclaw_gateway_processes");
    expect(script).toContain("$env:OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1'");
    expect(script).toContain(
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw update --tag",
    );
    expect(script).toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw update --tag");
    expect(script).toContain(
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 /opt/homebrew/bin/openclaw gateway stop",
    );
    expect(script).toContain("OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 openclaw gateway stop");
  });
});
