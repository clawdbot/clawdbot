import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { listSkillCommandsForAgents as listActualSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import {
  createNativeCommandTestParams,
  listSkillCommandsForAgents,
  resetNativeCommandMenuMocks,
  waitForRegisteredCommands,
} from "./bot-native-commands.menu-test-support.js";
import { resetPluginCommandMocks } from "./test-support/plugin-command.js";
import { writeSkill } from "./test-support/write-skill.js";

const tempDirs: string[] = [];

async function makeWorkspace(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("registerTelegramNativeCommands skill allowlist integration", () => {
  afterEach(async () => {
    resetNativeCommandMenuMocks();
    resetPluginCommandMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("registers only allowlisted skills for the bound agent menu", async () => {
    const workspaceDir = await makeWorkspace("openclaw-telegram-skills-");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha-skill"),
      name: "alpha-skill",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "beta-skill"),
      name: "beta-skill",
      description: "Beta skill",
    });

    const setMyCommands = vi.fn().mockResolvedValue(undefined);
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "alpha", workspace: workspaceDir, skills: ["alpha-skill"] },
          { id: "beta", workspace: workspaceDir, skills: ["beta-skill"] },
        ],
      },
      bindings: [
        {
          agentId: "alpha",
          match: { channel: "telegram", accountId: "bot-a" },
        },
      ],
    };
    listSkillCommandsForAgents.mockImplementation(
      ({ cfg, agentIds }: { cfg: OpenClawConfig; agentIds?: string[] }) =>
        listActualSkillCommandsForAgents({ cfg, agentIds }),
    );

    registerTelegramNativeCommands({
      ...createNativeCommandTestParams(cfg, {
        bot: {
          api: {
            setMyCommands,
            sendMessage: vi.fn().mockResolvedValue(undefined),
          },
          command: vi.fn(),
        } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
        runtime: { log: vi.fn() } as unknown as Parameters<
          typeof registerTelegramNativeCommands
        >[0]["runtime"],
        accountId: "bot-a",
      }),
    });

    const registeredCommands = await waitForRegisteredCommands(setMyCommands);

    expect(registeredCommands.some((entry) => entry.command === "alpha_skill")).toBe(true);
    expect(registeredCommands.some((entry) => entry.command === "beta_skill")).toBe(false);
  });
});
