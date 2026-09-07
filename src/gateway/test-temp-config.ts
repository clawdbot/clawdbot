// Temporary Gateway config test helper.
// Installs isolated config files and restores process-global config state.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  clearConfigCache,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";

function canonicalizeTempConfigForTest(cfg: unknown): unknown {
  if (!isRecord(cfg)) {
    return cfg;
  }
  const next = structuredClone(cfg);
  const agents = isRecord(next.agents) ? next.agents : undefined;
  if (!agents || !Array.isArray(agents.list)) {
    return next;
  }
  const entries = isRecord(agents.entries) ? { ...agents.entries } : {};
  for (const value of agents.list) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) {
      continue;
    }
    const { id, ...entry } = value;
    entries[id] = { ...entry, ...(isRecord(entries[id]) ? entries[id] : {}) };
  }
  agents.entries = entries;
  delete agents.list;
  return next;
}

/** Writes a temp OpenClaw config, installs it as runtime state, then restores globals. */
export async function withTempConfig(params: {
  cfg: unknown;
  run: () => Promise<void>;
  prefix?: string;
}): Promise<void> {
  const prevConfigPath = process.env.OPENCLAW_CONFIG_PATH;

  const testConfig = canonicalizeTempConfigForTest(params.cfg) as OpenClawConfig;
  const dir = await mkdtemp(path.join(os.tmpdir(), params.prefix ?? "openclaw-test-config-"));
  const configPath = path.join(dir, "openclaw.json");

  process.env.OPENCLAW_CONFIG_PATH = configPath;

  try {
    await writeFile(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    // Mirror both on-disk and runtime snapshots so code paths using either
    // config IO layer see the same isolated fixture.
    clearConfigCache();
    resetConfigRuntimeState();
    clearSecretsRuntimeSnapshot();
    setRuntimeConfigSnapshot(testConfig, testConfig);
    await params.run();
  } finally {
    if (prevConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = prevConfigPath;
    }
    clearConfigCache();
    resetConfigRuntimeState();
    clearSecretsRuntimeSnapshot();
    await rm(dir, { recursive: true, force: true });
  }
}
