import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const OS_SCRIPT_PATHS = [
  "scripts/e2e/parallels-linux-smoke.sh",
  "scripts/e2e/parallels-macos-smoke.sh",
  "scripts/e2e/parallels-windows-smoke.sh",
];
const NPM_UPDATE_SCRIPT_PATH = "scripts/e2e/parallels-npm-update-smoke.sh";

describe("Parallels smoke model selection", () => {
  it("keeps the OpenAI smoke lane on the stable direct API model by default", () => {
    for (const scriptPath of [...OS_SCRIPT_PATHS, NPM_UPDATE_SCRIPT_PATH]) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain(
        'MODEL_ID="${OPENCLAW_PARALLELS_OPENAI_MODEL:-openai/gpt-5.5}"',
      );
      expect(script, scriptPath).toContain("--model <provider/model>");
      expect(script, scriptPath).toContain("MODEL_ID_EXPLICIT=1");
    }
  });

  it("seeds agent workspace state before OS smoke agent turns", () => {
    for (const scriptPath of OS_SCRIPT_PATHS) {
      const script = readFileSync(scriptPath, "utf8");

      expect(script, scriptPath).toContain("workspace-state.json");
      expect(script, scriptPath).toContain("IDENTITY.md");
      expect(script, scriptPath).toContain("BOOTSTRAP.md");
      expect(script, scriptPath).toMatch(/--session-id\s+['"]?parallels-/);
      expect(script, scriptPath).toContain("agents.defaults.skipBootstrap true --strict-json");
    }
  });

  it("passes aggregate model overrides into each OS fresh lane", () => {
    const script = readFileSync(NPM_UPDATE_SCRIPT_PATH, "utf8");

    expect(script).toMatch(/parallels-macos-smoke\.sh"[\s\S]*?--model "\$MODEL_ID"/);
    expect(script).toMatch(/parallels-windows-smoke\.sh"[\s\S]*?--model "\$MODEL_ID"/);
    expect(script).toMatch(/parallels-linux-smoke\.sh"[\s\S]*?--model "\$MODEL_ID"/);
  });

  it("keeps Windows gateway reachability on a real deadline with start recovery", () => {
    const script = readFileSync("scripts/e2e/parallels-windows-smoke.sh", "utf8");

    expect(script).toContain(
      'GATEWAY_RECOVERY_AFTER_S="${OPENCLAW_PARALLELS_WINDOWS_GATEWAY_RECOVERY_AFTER_S:-180}"',
    );
    expect(script).toContain("deadline=$((SECONDS + TIMEOUT_GATEWAY_S))");
    expect(script).toContain("while (( SECONDS < deadline )); do");
    expect(script).toContain("run_gateway_daemon_action start");
  });
});
