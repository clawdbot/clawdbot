import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { windowsUpdateScript } from "../../scripts/e2e/parallels/npm-update-scripts.ts";

const SCRIPT_PATH = "scripts/e2e/parallels/npm-update-smoke.ts";
const UPDATE_SCRIPTS_PATH = "scripts/e2e/parallels/npm-update-scripts.ts";
const TEST_AUTH = {
  authChoice: "openai",
  authKeyFlag: "--openai-api-key",
  apiKeyEnv: "OPENAI_API_KEY",
  apiKeyValue: "test-key",
  modelId: "gpt-5.4",
};

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

  it("generates a .NET-safe Windows stale import regex in the update-failure guard", () => {
    const script = windowsUpdateScript({
      auth: TEST_AUTH,
      expectedNeedle: "2026.4.30",
      updateTarget: "latest",
    });
    const staleImportLine = script.match(/\$stalePostSwapImport = [^\n]+/)?.[0];
    const staleImportMatch = script.match(/\$updateText -match '(node_modules[^']+)'/);
    const staleImportPattern = staleImportMatch?.[1];

    if (!staleImportLine) {
      throw new Error("missing generated Windows stale import guard");
    }
    if (!staleImportPattern) {
      throw new Error("missing generated Windows stale import regex");
    }
    expect(staleImportLine).toContain("$updateText -match 'ERR_MODULE_NOT_FOUND'");
    expect(staleImportLine).toContain(`$updateText -match '${staleImportPattern}'`);
    expect(staleImportPattern).toBe(
      String.raw`node_modules\\openclaw\\dist\\[^\\]+-[A-Za-z0-9_-]+\.js`,
    );
    expect(staleImportPattern).not.toContain("node_modules\\openclaw\\dist\\");
    expect(staleImportPattern.match(/\\\\/g)).toHaveLength(4);
    const representativeUpdateFailure = String.raw`Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'C:\Users\runner\AppData\Roaming\npm\node_modules\openclaw\dist\main-a1_B2.js' imported from C:\Users\runner\AppData\Roaming\npm\node_modules\openclaw\dist\cli.js`;
    const generatedRegex = new RegExp(staleImportPattern);
    expect(generatedRegex.test(representativeUpdateFailure)).toBe(true);
    expect(generatedRegex.test(String.raw`node_modules\openclaw\dist\main.js`)).toBe(false);
  });
});
