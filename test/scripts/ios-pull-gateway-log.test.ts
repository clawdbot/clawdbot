import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/dev/ios-pull-gateway-log.sh";

describe("scripts/dev/ios-pull-gateway-log.sh", () => {
  it("does not bake local device or bundle identifiers into the log pull helper", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('DEVICE_UDID="${1:-${OPENCLAW_IOS_DEVICE_UDID:-}}"');
    expect(script).toContain('BUNDLE_ID="${2:-${OPENCLAW_IOS_BUNDLE_ID:-}}"');
    expect(script).toContain('DEST="${3:-${OPENCLAW_IOS_GATEWAY_LOG_DEST:-}}"');
    expect(script).toContain('mktemp -d "${TMPDIR:-/tmp}/openclaw-ios-gateway.XXXXXX"');
    expect(script).toContain('exit 2');
    expect(script).not.toMatch(/DEVICE_UDID="\$\{1:-[0-9A-F-]+/u);
    expect(script).not.toMatch(/BUNDLE_ID="\$\{2:-ai\.openclaw\.ios\.dev\.[^}]+/u);
    expect(script).not.toContain("/tmp/openclaw-gateway.log");
  });
});
