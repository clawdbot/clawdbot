// Release Media Memory Scenario tests cover release media memory scenario script behavior.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCENARIO = "scripts/e2e/lib/release-media-memory/scenario.sh";

describe("release media memory scenario", () => {
  it("fails when packaged plugin listing is broken or omits memory-core", () => {
    const script = readFileSync(SCENARIO, "utf8");
    const listIndex = script.indexOf('openclaw plugins list --json >"$PLUGINS_JSON"');
    const assertIndex = script.indexOf('assert-file-contains "$PLUGINS_JSON" memory-core');

    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(assertIndex).toBeGreaterThan(listIndex);
    expect(script.slice(listIndex, assertIndex)).not.toContain("|| true");
  });

  it("uses portable package file listing syntax", () => {
    const script = readFileSync(SCENARIO, "utf8");

    expect(script).not.toContain("-printf");
  });

  it("uses a per-run temp root for generated media artifacts", () => {
    const script = readFileSync(SCENARIO, "utf8");

    expect(script).toContain('media_root="$(mktemp -d /tmp/openclaw-release-media-memory.XXXXXX)"');
    expect(script).toContain('rm -rf "$media_root"');
    expect(script).toContain('MOCK_REQUEST_LOG="$media_root/openai-requests.jsonl"');
    expect(script).toContain('PLUGINS_JSON="$media_root/plugins.json"');
    expect(script).toContain('--file "$media_root/input.png"');
    expect(script).toContain('--output "$media_root/generated.png"');
    expect(script).not.toContain("/tmp/openclaw-release-media-memory-plugins.json");
    expect(script).not.toContain(
      'mkdir -p "$OPENCLAW_STATE_DIR/workspace/memory" /tmp/openclaw-release-media-memory',
    );
  });
});
