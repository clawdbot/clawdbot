import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SettingsManager } from "../sessions/settings-manager.js";
import { createEmbeddedAgentResourceLoader } from "./resource-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("createEmbeddedAgentResourceLoader", () => {
  it.each(["workspace", "agent"])(
    "keeps inline extensions without discovering %s instructions or prompts",
    async (location) => {
      const cwd = tempDirs.make("openclaw-embedded-resources-");
      const agentDir = join(cwd, "agent");
      const resourceDir = location === "workspace" ? join(cwd, ".openclaw") : agentDir;
      await mkdir(resourceDir, { recursive: true });
      await writeFile(join(cwd, "AGENTS.md"), "ambient context");
      await writeFile(join(resourceDir, "SYSTEM.md"), "ambient system prompt");
      await writeFile(join(resourceDir, "APPEND_SYSTEM.md"), "ambient appended prompt");
      const loader = createEmbeddedAgentResourceLoader({
        cwd,
        agentDir,
        settingsManager: SettingsManager.inMemory(),
        extensionFactories: [
          (api) => {
            api.registerCommand("inline-command", {
              description: "inline",
              handler: async () => {},
            });
          },
        ],
      });

      await loader.reload();

      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions[0]?.commands.has("inline-command")).toBe(true);
      expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
      expect.soft(loader.getSystemPrompt()).toBeUndefined();
      expect.soft(loader.getAppendSystemPrompt()).toEqual([]);
    },
  );
});
