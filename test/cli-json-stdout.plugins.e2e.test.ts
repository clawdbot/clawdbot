import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { runBuiltCli } from "./cli-json-stdout.test-support.js";

describe("cli json stdout contract", () => {
  it.each([
    {
      name: "the search query is missing",
      args: ["plugins", "search", "--json"],
      message: "Usage: openclaw plugins search <query>",
    },
    {
      name: "ClawHub transport fails",
      args: ["plugins", "search", "fixture", "--json"],
      message: "offline fixture",
    },
  ])("returns one canonical JSON document when plugins $name", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'globalThis.fetch = async () => { throw new Error("offline fixture"); };',
        )}`;
        const result = runBuiltCli(tempHome, testCase.args, {
          NODE_OPTIONS: `--import=${preload}`,
          OPENCLAW_STATE_DIR: path.join(tempHome, "isolated-state"),
          OPENCLAW_CONFIG_PATH: path.join(tempHome, "missing-openclaw.json"),
          CLAWHUB_CONFIG_PATH: path.join(tempHome, "missing-clawhub.json"),
          CLAWHUB_TOKEN: "",
          CLAWHUB_AUTH_TOKEN: "",
        });

        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout, result.stderr).not.toBe("");
        expect(result.stdout).not.toMatch(/[\u001B\u0007]/u);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: testCase.message,
          },
        });
        expect(result.stderr).toContain(testCase.message);
      },
      { prefix: "openclaw-plugins-json-failure-e2e-" },
    );
  });

  it("keeps plugins search JSON failures clean through dual-TTY finalization", async () => {
    await withTempHome(
      async (tempHome) => {
        const preload = `data:text/javascript,${encodeURIComponent(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        )}`;
        const result = runBuiltCli(tempHome, ["plugins", "search", "--json"], {
          NODE_OPTIONS: `--import=${preload}`,
        });

        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          error: {
            type: "cli_error",
            message: "Usage: openclaw plugins search <query>",
          },
        });
        expect(result.stdout).not.toMatch(/[\u001B\u0007]/u);
        expect(result.stderr).toContain("Usage: openclaw plugins search <query>");
        expect(result.stderr).toContain("\u001B[?25h");
      },
      { prefix: "openclaw-plugins-json-tty-failure-e2e-" },
    );
  });

  it.each([
    { name: "a missing local marketplace", source: "local" },
    {
      name: "a missing local marketplace through forced Commander",
      source: "local",
      commander: true,
    },
    { name: "a missing local marketplace with dual TTYs", source: "local", tty: true },
    { name: "an unavailable Git marketplace", source: "git" },
    { name: "an unavailable Git marketplace with dual TTYs", source: "git", tty: true },
    { name: "a missing local marketplace in human mode", source: "local", human: true },
    { name: "an unavailable Git marketplace in human mode", source: "git", human: true },
  ])("keeps $name failures on the canonical marketplace output boundary", async (testCase) => {
    await withTempHome(
      async (tempHome) => {
        const stateDir = path.join(tempHome, "isolated-state");
        const configPath = path.join(tempHome, "missing-openclaw.json");
        const source =
          testCase.source === "git"
            ? "ssh://marketplace.invalid/openclaw/unavailable.git"
            : path.join(tempHome, "missing-marketplace");
        const ttyPreload = Buffer.from(
          'Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true }); Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });',
        ).toString("base64");

        await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });

        const result = runBuiltCli(
          tempHome,
          ["plugins", "marketplace", "list", source, ...("human" in testCase ? [] : ["--json"])],
          {
            GIT_SSH_COMMAND: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
            GIT_TERMINAL_PROMPT: "0",
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_STATE_DIR: stateDir,
            ...("commander" in testCase ? { OPENCLAW_DISABLE_ROUTE_FIRST: "1" } : {}),
            ...("tty" in testCase
              ? { NODE_OPTIONS: `--import=data:text/javascript;base64,${ttyPreload}` }
              : {}),
          },
          { inheritEnvironment: false },
        );
        const expectedMessage =
          testCase.source === "git"
            ? `failed to clone marketplace source ${source}:`
            : `unsupported marketplace source: ${source}`;

        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain(expectedMessage);

        if ("human" in testCase) {
          if (testCase.source === "git") {
            expect(result.stdout).toContain(`Cloning marketplace source ${source}...`);
          }
        } else {
          expect(result.stdout, result.stderr).not.toMatch(/[\u001B\u0007]/u);
          expect(result.stdout).not.toContain("Cloning marketplace source");
          expect(JSON.parse(result.stdout)).toEqual({
            ok: false,
            error: {
              type: "cli_error",
              message:
                testCase.source === "git"
                  ? expect.stringContaining(expectedMessage)
                  : expectedMessage,
            },
          });
          if ("tty" in testCase) {
            expect(result.stderr).toContain("\u001B[?25h");
          }
        }

        if (testCase.source === "git") {
          expect(result.stderr).toContain("fatal: Could not read from remote repository.");
          const clonePath = /Cloning into '([^']+)'\.\.\./u.exec(result.stderr)?.[1];
          expect(clonePath).toBeDefined();
          await expect(fs.stat(path.dirname(clonePath as string))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }

        await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(path.join(tempHome, ".claude"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
      { prefix: "openclaw-marketplace-json-failure-e2e-" },
    );
  });
});
