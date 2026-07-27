// CLI JSON stdout E2E tests validate machine-readable CLI output.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";

function runSourceCli(tempHome: string, args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_TEST_FAST: "1",
  };
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.VITEST;
  Object.assign(env, envOverrides);

  const entry = path.resolve(process.cwd(), "src/entry.ts");
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

describe("cli json stdout contract", () => {
  it.each([
    { name: "default service", inheritedProfile: undefined, inheritedStateName: ".openclaw" },
    { name: "named service", inheritedProfile: "main", inheritedStateName: ".openclaw-main" },
  ])("resolves the requested profile from inherited $name state", async (inherited) => {
    await withTempHome(
      async (tempHome) => {
        const inheritedStateDir = path.join(tempHome, inherited.inheritedStateName);
        const result = runSourceCli(tempHome, ["--profile", "work", "config", "file"], {
          OPENCLAW_PROFILE: inherited.inheritedProfile,
          OPENCLAW_STATE_DIR: inheritedStateDir,
          OPENCLAW_CONFIG_PATH: path.join(inheritedStateDir, "openclaw.json"),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(path.join(tempHome, ".openclaw-work", "openclaw.json"));
      },
      { prefix: "openclaw-profile-isolation-e2e-" },
    );
  });

  it("keeps default-profile exec approvals untouched for a scratch-state config query", async () => {
    await withTempHome(
      async (tempHome) => {
        const defaultStateDir = path.join(tempHome, ".openclaw");
        const scratchStateDir = path.join(tempHome, "scratch-state");
        const approvalsPath = path.join(defaultStateDir, "exec-approvals.json");
        const approvals = '{"version":1,"approvals":{"demo":true}}\n';
        await fs.mkdir(defaultStateDir, { recursive: true });
        await fs.mkdir(scratchStateDir, { recursive: true });
        await fs.writeFile(approvalsPath, approvals, "utf8");

        const result = runSourceCli(tempHome, ["config", "file"], {
          OPENCLAW_STATE_DIR: scratchStateDir,
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(path.join(scratchStateDir, "openclaw.json"));
        await expect(fs.readFile(approvalsPath, "utf8")).resolves.toBe(approvals);
        await expect(fs.access(`${approvalsPath}.migrated`)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(
          fs.access(path.join(scratchStateDir, "exec-approvals.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-read-only-state-e2e-" },
    );
  });

  it("keeps `update status --json` stdout parseable even with legacy doctor preflight inputs", async () => {
    await withTempHome(
      async (tempHome) => {
        const legacyDir = path.join(tempHome, ".clawdbot");
        await fs.mkdir(legacyDir, { recursive: true });
        await fs.writeFile(path.join(legacyDir, "clawdbot.json"), "{}", "utf8");

        const result = runSourceCli(tempHome, ["update", "status", "--json", "--timeout", "1"]);

        expect(result.status).toBe(0);
        const stdout = result.stdout.trim();
        expect(stdout.length).toBeGreaterThan(0);
        const parsed = JSON.parse(stdout) as unknown;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(`Expected JSON object stdout, got: ${stdout}`);
        }
        expect(Object.keys(parsed).toSorted((a, b) => a.localeCompare(b))).toEqual([
          "availability",
          "channel",
          "update",
        ]);
        expect(stdout).not.toContain("Doctor warnings");
        expect(stdout).not.toContain("Doctor changes");
        expect(stdout).not.toContain("Config invalid");
      },
      { prefix: "openclaw-json-e2e-" },
    );
  });

  it("keeps `config schema` stdout parseable at debug log level", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runSourceCli(tempHome, ["config", "schema"], {
          OPENCLAW_LOG_LEVEL: "debug",
        });

        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout) as {
          properties?: Record<string, unknown>;
        };
        expect(parsed.properties?.$schema).toEqual({ type: "string" });
        expect(result.stdout).not.toContain("possibly sensitive key found");
        expect(result.stderr).not.toContain("possibly sensitive key found");
      },
      { prefix: "openclaw-config-schema-json-e2e-" },
    );
  });

  it("keeps `config validate --json` stdout parseable at debug log level", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        await fs.writeFile(configPath, "{}", "utf8");
        const result = runSourceCli(tempHome, ["config", "validate", "--json"], {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_LOG_LEVEL: "debug",
        });

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          valid: true,
          path: configPath,
        });
        expect(result.stdout).not.toContain("possibly sensitive key found");
      },
      { prefix: "openclaw-config-validate-json-e2e-" },
    );
  });
});
