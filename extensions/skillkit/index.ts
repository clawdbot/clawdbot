import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import {
  SkillkitSearchSchema,
  executeSkillkitSearch,
  SkillkitInstallSchema,
  executeSkillkitInstall,
  SkillkitTranslateSchema,
  executeSkillkitTranslate,
  SkillkitRecommendSchema,
  executeSkillkitRecommend,
  SkillkitSyncSchema,
  executeSkillkitSync,
  SkillkitListSchema,
  executeSkillkitList,
  SkillkitContextSchema,
  executeSkillkitContext,
  SkillkitPublishSchema,
  executeSkillkitPublish,
  SkillkitMemorySchema,
  executeSkillkitMemory,
} from "./src/tools.js";

const plugin = {
  id: "skillkit",
  name: "SkillKit",
  description:
    "Universal AI agent skills management - search, install, translate, and sync skills across 17 coding agents",
  configSchema: emptyPluginConfigSchema(),
  register(api: MoltbotPluginApi) {
    api.registerTool({
      name: "skillkit_search",
      label: "SkillKit Search",
      description:
        "Search the SkillKit marketplace for AI agent skills. " +
        "Browse 15,000+ skills from curated sources including Cursor, Claude Code, Codex, and more.",
      parameters: SkillkitSearchSchema,
      execute: executeSkillkitSearch,
    });

    api.registerTool({
      name: "skillkit_install",
      label: "SkillKit Install",
      description:
        "Install a skill from the SkillKit marketplace. " +
        "Automatically translates skills to the target agent format.",
      parameters: SkillkitInstallSchema,
      execute: executeSkillkitInstall,
    });

    api.registerTool({
      name: "skillkit_translate",
      label: "SkillKit Translate",
      description:
        "Translate skills between different AI agent formats. " +
        "Supports Cursor, Claude Code, Codex, Gemini CLI, Windsurf, Roo, and 11 more agents.",
      parameters: SkillkitTranslateSchema,
      execute: executeSkillkitTranslate,
    });

    api.registerTool({
      name: "skillkit_recommend",
      label: "SkillKit Recommend",
      description:
        "Get smart skill recommendations based on your project's tech stack, " +
        "dependencies, and codebase patterns.",
      parameters: SkillkitRecommendSchema,
      execute: executeSkillkitRecommend,
    });

    api.registerTool({
      name: "skillkit_sync",
      label: "SkillKit Sync",
      description:
        "Sync skills between local and remote configurations. " +
        "Push local skills to team storage or pull team skills locally.",
      parameters: SkillkitSyncSchema,
      execute: executeSkillkitSync,
    });

    api.registerTool({
      name: "skillkit_list",
      label: "SkillKit List",
      description:
        "List available or installed skills. " +
        "Filter by agent or show only locally installed skills.",
      parameters: SkillkitListSchema,
      execute: executeSkillkitList,
    });

    api.registerTool({
      name: "skillkit_context",
      label: "SkillKit Context",
      description:
        "Analyze project context to understand tech stack, dependencies, and patterns. " +
        "Used for intelligent skill recommendations.",
      parameters: SkillkitContextSchema,
      execute: executeSkillkitContext,
    });

    api.registerTool({
      name: "skillkit_publish",
      label: "SkillKit Publish",
      description:
        "Publish a skill to the SkillKit marketplace. " +
        "Share your custom skills with the community.",
      parameters: SkillkitPublishSchema,
      execute: executeSkillkitPublish,
    });

    api.registerTool({
      name: "skillkit_memory",
      label: "SkillKit Memory",
      description:
        "Manage SkillKit memory for persisting skill preferences and configurations. " +
        "Save, load, list, or clear memory entries.",
      parameters: SkillkitMemorySchema,
      execute: executeSkillkitMemory,
    });
  },
};

export default plugin;
