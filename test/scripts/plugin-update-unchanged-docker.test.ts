import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PLUGIN_UPDATE_DOCKER_SCRIPT = "scripts/e2e/plugin-update-unchanged-docker.sh";

describe("plugin update unchanged Docker E2E", () => {
  it("seeds current plugin install ledger state before checking config stability", () => {
    const script = readFileSync(PLUGIN_UPDATE_DOCKER_SCRIPT, "utf8");
    const configSeedStart = script.indexOf('cat > \\"\\$HOME/.openclaw/openclaw.json\\"');
    const configSeedEnd = script.indexOf('cat > \\"\\$HOME/.openclaw/plugins/installs.json\\"');
    const configSeed = script.slice(configSeedStart, configSeedEnd);

    expect(configSeedStart).toBeGreaterThanOrEqual(0);
    expect(configSeedEnd).toBeGreaterThan(configSeedStart);
    expect(configSeed).toContain('\\"plugins\\": {}');
    expect(configSeed).not.toContain('\\"installs\\"');
    expect(script).toContain('\\"installRecords\\": {');
    expect(script).toContain('\\"lossless-claw\\": {');
  });
});
