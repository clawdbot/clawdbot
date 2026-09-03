import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "node identity",
      args: ["node", "identity", "--json"],
      overrides: {},
      error: "no node device identity found",
    },
    {
      name: "routed config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: {},
    },
    {
      name: "Commander config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
    },
    {
      name: "Nix config get",
      args: ["config", "get", "gateway.port", "--json"],
      overrides: { OPENCLAW_NIX_MODE: "1" },
    },
    { name: "config schema", args: ["config", "schema"], overrides: {} },
    {
      name: "Nix config schema",
      args: ["config", "schema"],
      overrides: { OPENCLAW_NIX_MODE: "1" },
    },
    { name: "config validate", args: ["config", "validate", "--json"], overrides: {} },
    {
      name: "Nix config validate",
      args: ["config", "validate", "--json"],
      overrides: { OPENCLAW_NIX_MODE: "1" },
    },
  ])("does not initialize shared SQLite for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-openclaw.json");
        const config = `${JSON.stringify({
          gateway: {
            mode: "local",
            port: 18789,
            auth: { mode: "token", token: randomBytes(32).toString("hex") },
          },
          plugins: { enabled: false },
          browser: { enabled: false },
          discovery: { mdns: { mode: "off" } },
          logging: { file: path.join(stateDir, "openclaw.log") },
        })}\n`;
        await fs.writeFile(configPath, config, "utf8");
        const configBefore = await fs.stat(configPath);
        const tmpDir = path.join(tempHome, "tmp");
        await fs.mkdir(tmpDir);

        const result = runBuiltCli(
          tempHome,
          testCase.args,
          {
            OPENCLAW_HOME: tempHome,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_TEST_FAST: undefined,
            TMPDIR: tmpDir,
            TMP: tmpDir,
            TEMP: tmpDir,
            PATH: path.dirname(process.execPath),
            ...testCase.overrides,
          },
          { inheritEnvironment: false },
        );

        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe("error" in testCase ? 1 : 0);
        if ("error" in testCase) {
          expect(result.stderr).toContain(testCase.error);
          expect(result.stdout).toBe("");
        } else {
          expect(() => JSON.parse(result.stdout)).not.toThrow();
        }
        await expect(
          fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect((await fs.readFile(configPath, "utf8")) === config).toBe(true);
        expect(await fs.stat(configPath)).toMatchObject({
          ino: configBefore.ino,
          mode: configBefore.mode,
          mtimeMs: configBefore.mtimeMs,
          ctimeMs: configBefore.ctimeMs,
        });
      },
      { prefix: "openclaw-read-only-config-e2e-" },
    );
  });

  it.each([
    { name: "routed malformed config get", overrides: {} },
    {
      name: "Commander malformed config get",
      overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
    },
  ])("returns actionable JSON without creating state for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-openclaw.json");
        await fs.writeFile(configPath, "{}\n", "utf8");

        const result = runBuiltCli(
          tempHome,
          ["config", "get", "gateway.__proto__.token", "--json"],
          {
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
            ...testCase.overrides,
          },
        );

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("Invalid path segment: __proto__"),
          },
        });
        expect(result.stderr).toBe("");
        await expect(
          fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "openclaw-read-only-invalid-config-e2e-" },
    );
  });

  it.each([
    { name: "routed invalid config get", overrides: {} },
    {
      name: "Commander invalid config get",
      overrides: { OPENCLAW_DISABLE_ROUTE_FIRST: "1" },
    },
  ])("reports invalid configuration as JSON without creating state for $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "read-only-state");
        const configPath = path.join(tempHome, "read-only-openclaw.json");
        await fs.writeFile(
          configPath,
          `${JSON.stringify({ gateway: { bind: "not-a-supported-mode" } })}\n`,
          "utf8",
        );

        const result = runBuiltCli(tempHome, ["config", "get", "gateway.port", "--json"], {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          ...testCase.overrides,
        });

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: {
            type: "cli_error",
            message: expect.stringContaining("OpenClaw config is invalid"),
          },
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "gateway.bind", message: expect.any(String) }),
          ]),
        });
        expect(result.stderr).toBe("");
        await expect(
          fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "openclaw-read-only-invalid-snapshot-e2e-" },
    );
  });

  it.each([
    { name: "default service", inheritedProfile: undefined, inheritedStateName: ".openclaw" },
    { name: "named service", inheritedProfile: "main", inheritedStateName: ".openclaw-main" },
  ])("resolves the requested profile from inherited $name state", async (inherited) => {
    await withTempHome(
      async (tempHome) => {
        const inheritedStateDir = path.join(tempHome, inherited.inheritedStateName);
        const result = runBuiltCli(tempHome, ["--profile", "work", "config", "file"], {
          OPENCLAW_PROFILE: inherited.inheritedProfile,
          OPENCLAW_STATE_DIR: inheritedStateDir,
          OPENCLAW_CONFIG_PATH: path.join(inheritedStateDir, "openclaw.json"),
        });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(path.join(tempHome, ".openclaw-work", "openclaw.json"));
        await expect(fs.access(path.join(tempHome, ".openclaw-work"))).rejects.toMatchObject({
          code: "ENOENT",
        });
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

        const result = runBuiltCli(tempHome, ["config", "file"], {
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
        await expect(
          fs.access(path.join(scratchStateDir, "state", "openclaw.sqlite")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      },
      { prefix: "openclaw-read-only-state-e2e-" },
    );
  });

  it("keeps representative success payload bytes unchanged", async () => {
    await withTempHome(
      async (tempHome) => {
        const configPath = path.join(tempHome, "openclaw.json");
        await fs.writeFile(configPath, '{"gateway":{"port":28789}}\n', "utf8");
        const env = { OPENCLAW_CONFIG_PATH: configPath };

        const getResult = runBuiltCli(tempHome, ["config", "get", "gateway.port", "--json"], env);
        const validateResult = runBuiltCli(tempHome, ["config", "validate", "--json"], env);

        expect(getResult.status, getResult.stderr).toBe(0);
        expect(getResult.stdout).toBe("28789\n");
        expect(validateResult.status, validateResult.stderr).toBe(0);
        expect(validateResult.stdout).toBe(
          `${JSON.stringify({ valid: true, path: configPath, warnings: [] })}\n`,
        );
      },
      { prefix: "openclaw-json-success-bytes-e2e-" },
    );
  });

  it("keeps `config schema` stdout parseable at debug log level", async () => {
    await withTempHome(
      async (tempHome) => {
        const result = runBuiltCli(tempHome, ["config", "schema"], {
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
        const result = runBuiltCli(tempHome, ["config", "validate", "--json"], {
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
