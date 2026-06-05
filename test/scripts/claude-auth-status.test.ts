// Claude Auth Status tests cover claude auth status script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.ts";

const SCRIPT = "scripts/claude-auth-status.sh";

describe("claude-auth-status.sh", () => {
  const harness = createScriptTestHarness();

  it("prints expiry timestamps on macOS without GNU date", () => {
    const root = harness.createTempDir("openclaw-claude-auth-status-");
    const bin = path.join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const openclaw = path.join(bin, "openclaw");
    const futureMs = String(Date.now() + 2 * 60 * 60 * 1000);

    writeFileSync(
      openclaw,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "$*" = "models status --json" ]; then',
        "cat <<'JSON'",
        JSON.stringify({
          auth: {
            oauth: {
              profiles: [
                {
                  provider: "anthropic",
                  type: "oauth",
                  profileId: "anthropic:test",
                  expiresAt: Number(futureMs),
                },
              ],
            },
            providers: [{ provider: "anthropic", profiles: { apiKey: 0 } }],
          },
        }),
        "JSON",
        "else",
        "exit 2",
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(openclaw, 0o755);

    const result = spawnSync("bash", [SCRIPT, "full"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("date:");
    expect(result.stdout).toContain("Claude Code Auth Status");
    expect(result.stdout.match(/Expires:/g)).toHaveLength(2);
  });
});
