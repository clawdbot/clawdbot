import fs from "node:fs/promises";

import JSON5 from "json5";

import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../agents/workspace.js";
import { type ClawdbotConfig, CONFIG_PATH_CLAWDBOT, writeConfigFile } from "../config/config.js";
import { formatConfigPath, logConfigUpdated } from "../config/logging.js";
import { resolveSessionTranscriptsDir } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

async function readConfigFileRaw(): Promise<{
  exists: boolean;
  parsed: ClawdbotConfig;
}> {
  try {
    const raw = await fs.readFile(CONFIG_PATH_CLAWDBOT, "utf-8");
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { exists: true, parsed: parsed as ClawdbotConfig };
    }
    return { exists: true, parsed: {} };
  } catch {
    return { exists: false, parsed: {} };
  }
}

export async function setupCommand(
  opts?: { workspace?: string },
  runtime: RuntimeEnv = defaultRuntime,
) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;

  const existingRaw = await readConfigFileRaw();
  const cfg = existingRaw.parsed;
  const defaults = cfg.agents?.defaults ?? {};

  const workspace = desiredWorkspace ?? defaults.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;

  const next: ClawdbotConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        workspace,
      },
    },
  };

  if (!existingRaw.exists || defaults.workspace !== workspace) {
    await writeConfigFile(next);
    if (!existingRaw.exists) {
      runtime.log(`Wrote ${formatConfigPath()}`);
    } else {
      logConfigUpdated(runtime, { suffix: "(set agents.defaults.workspace)" });
    }
  } else {
    runtime.log(`Config OK: ${formatConfigPath()}`);
  }

  const ws = await ensureAgentWorkspace({
    dir: workspace,
    ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap,
  });
  runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);

  const sessionsDir = resolveSessionTranscriptsDir();
  await fs.mkdir(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
}
