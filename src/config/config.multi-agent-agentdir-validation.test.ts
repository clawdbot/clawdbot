// Verifies multi-agent agent directory validation and rejection paths.
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "./config.js";
import { createConfigIO } from "./io.factory.js";
import { withTempHome, withTempHomeConfig, writeOpenClawConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.js";
import { validateConfigObject } from "./validation.js";

describe("multi-agent agentDir validation", () => {
  it.each(["HOME", "USERPROFILE", "OPENCLAW_HOME", "homedir", "relative OPENCLAW_HOME"] as const)(
    "keeps config validation and runtime paths in the selected %s",
    async (homeSource) => {
      await withTempHome(async (cliHome) => {
        const daemonHome = path.join(cliHome, "daemon");
        const daemonShared = path.join(daemonHome, "shared");
        const cliShared = path.join(cliHome, "shared");
        await fs.mkdir(daemonShared, { recursive: true });
        await fs.mkdir(cliShared);
        const env: NodeJS.ProcessEnv =
          homeSource === "homedir"
            ? {}
            : homeSource === "relative OPENCLAW_HOME"
              ? { OPENCLAW_HOME: "~/daemon" }
              : { [homeSource]: daemonHome };
        const config: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: { a: { agentDir: "~/shared" }, b: { agentDir: cliShared } },
          },
        };
        const configPath = await writeOpenClawConfig(daemonHome, config);
        const raw = await fs.readFile(configPath, "utf8");
        const io = createConfigIO({
          configPath,
          env,
          homedir: homeSource === "relative OPENCLAW_HOME" ? undefined : () => daemonHome,
          observe: false,
          pluginValidation: "core-only",
          logger: { error: vi.fn(), warn: vi.fn() },
        });

        const snapshot = await io.readConfigFileSnapshot();
        expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
        const expected = { a: { agentDir: daemonShared }, b: { agentDir: cliShared } };
        expect(snapshot.runtimeConfig.agents?.entries).toEqual(expected);
        expect(io.loadConfig().agents?.entries).toEqual(expected);
        expect(snapshot.sourceConfig.agents?.entries).toEqual(config.agents?.entries);
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(raw);

        await writeOpenClawConfig(daemonHome, {
          agents: {
            ownership: "explicit",
            entries: { a: { agentDir: "~/shared" }, b: { agentDir: daemonShared } },
          },
        });
        const collision = await io.readConfigFileSnapshot();
        expect(collision.valid).toBe(false);
        expect(collision.issues).toContainEqual({
          path: "agents.entries",
          message: expect.stringContaining("Duplicate agentDir"),
        });
        expect(() => io.loadConfig()).toThrow(/Duplicate agentDir/);
      });
    },
  );

  it("rejects shared agents.entries agentDir", () => {
    const shared = path.join(tmpdir(), "openclaw-shared-agentdir");
    const res = validateConfigObject({
      agents: {
        entries: { a: { agentDir: shared, default: true }, b: { agentDir: shared } },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toEqual([
        {
          path: "agents.entries",
          message: `Duplicate agentDir detected (multi-agent config).
Each agent must have a unique agentDir; sharing it causes auth/session state collisions and token invalidation.

Conflicts:
- ${shared}: "a", "b"

Fix: remove the shared agents.entries.*.agentDir override (or give each agent its own directory).
Auth profiles live in each agent's SQLite store, so a shared agentDir is not how credentials are shared: give each agent its own directory and either leave its store empty to inherit the main agent's profiles, or log it in with \`openclaw models auth login\`.`,
        },
      ]);
    }
  });

  it("throws on shared agentDir during getRuntimeConfig()", async () => {
    await withTempHomeConfig(
      {
        agents: {
          entries: {
            a: { agentDir: "~/.openclaw/agents/shared/agent", default: true },
            b: { agentDir: "~/.openclaw/agents/shared/agent" },
          },
        },
        bindings: [{ agentId: "a", match: { channel: "forum" } }],
      },
      async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        expect(() => getRuntimeConfig()).toThrow(/duplicate agentDir/i);
        expect(spy.mock.calls.flat().join(" ")).toMatch(/Duplicate agentDir/i);
        spy.mockRestore();
      },
    );
  });
});
