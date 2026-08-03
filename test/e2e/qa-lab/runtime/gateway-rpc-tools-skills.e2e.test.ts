import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { captureEnv, setTestEnvValue } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const TEST_TIMEOUT_MS = 30_000;
const SKILL_CARD = "# Catalog Proof\n\nLocal Gateway skill-card evidence.\n";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

async function setupTempHome() {
  const env = captureEnv([...ENV_KEYS]);
  const home = tempDirs.make("openclaw-rpc-tools-skills-");
  const stateDir = path.join(home, ".openclaw");
  const workspace = path.join(home, "workspace");
  const bundledPlugins = path.join(home, "empty-bundled-plugins");
  const skillDir = path.join(workspace, "skills", "catalog-proof");
  await Promise.all([
    fs.mkdir(stateDir, { recursive: true }),
    fs.mkdir(skillDir, { recursive: true }),
    fs.mkdir(bundledPlugins, { recursive: true }),
  ]);
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: catalog-proof",
      "description: Fixture skill for Gateway catalog proof.",
      "---",
      "",
      "# Catalog Proof",
      "",
      "Use this fixture only for local QA evidence.",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(skillDir, "skill-card.md"), SKILL_CARD, "utf8");
  setTestEnvValue("HOME", home);
  setTestEnvValue("USERPROFILE", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  setTestEnvValue("OPENCLAW_SKIP_CHANNELS", "1");
  setTestEnvValue("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
  setTestEnvValue("OPENCLAW_SKIP_CRON", "1");
  setTestEnvValue("OPENCLAW_SKIP_CANVAS_HOST", "1");
  setTestEnvValue("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
  setTestEnvValue("OPENCLAW_SKIP_PROVIDERS", "1");
  setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledPlugins);
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
  return {
    configPath: path.join(stateDir, "openclaw.json"),
    env,
    home,
    skillDir,
    workspace,
  };
}

describe("gateway RPC tool and skill catalogs", () => {
  it(
    "returns built-in commands, core tools, and a readable workspace skill card",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const temp = await setupTempHome();
      const token = `rpc-tools-skills-${process.pid}`;
      let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        started = await startGatewayWithClient({
          cfg: {
            agents: { defaults: { workspace: temp.workspace } },
            gateway: { auth: { mode: "token", token } },
          },
          configPath: temp.configPath,
          token,
          clientDisplayName: "rpc-tools-skills-reader",
        });

        const commands = (await started.client.request("commands.list", {})) as {
          commands: Array<{ name: string; source: string }>;
        };
        expect(commands.commands).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "model", source: "native" })]),
        );

        const tools = (await started.client.request("tools.catalog", {
          includePlugins: false,
        })) as {
          groups: Array<{ source: string; tools: Array<{ id: string; source: string }> }>;
        };
        expect(tools.groups.flatMap((group) => group.tools)).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: "tts", source: "core" })]),
        );
        expect(tools.groups.some((group) => group.source === "plugin")).toBe(false);

        const status = (await started.client.request("skills.status", {})) as {
          workspaceDir: string;
          skills: Array<{
            name: string;
            skillKey: string;
            skillCard?: { path: string; present: boolean; sizeBytes: number };
          }>;
        };
        expect(status.workspaceDir).toBe(temp.workspace);
        const fixture = status.skills.find((skill) => skill.name === "catalog-proof");
        expect(fixture).toEqual(
          expect.objectContaining({
            name: "catalog-proof",
            skillKey: "catalog-proof",
            skillCard: {
              path: path.join(temp.skillDir, "skill-card.md"),
              present: true,
              sizeBytes: Buffer.byteLength(SKILL_CARD),
            },
          }),
        );

        const card = await started.client.request("skills.skillCard", {
          skillKey: "catalog-proof",
        });
        expect(card).toEqual({
          schema: "openclaw.skills.skill-card.v1",
          skillKey: "catalog-proof",
          path: path.join(temp.skillDir, "skill-card.md"),
          sizeBytes: Buffer.byteLength(SKILL_CARD),
          content: SKILL_CARD,
        });
      } finally {
        try {
          if (started) {
            await disconnectGatewayClient(started.client).catch(() => undefined);
            await started.server.close({
              reason: "gateway RPC tool/skill catalog proof complete",
            });
          }
        } finally {
          temp.env.restore();
        }
      }
    },
  );
});
