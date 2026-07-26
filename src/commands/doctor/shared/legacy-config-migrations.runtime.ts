// Aggregated runtime legacy config migration specs across agents, gateway, models, and tools.
import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS } from "./legacy-config-migrations.runtime.agents.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS } from "./legacy-config-migrations.runtime.cli-backends.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS } from "./legacy-config-migrations.runtime.diagnostics.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES } from "./legacy-config-migrations.runtime.entries.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY } from "./legacy-config-migrations.runtime.gateway.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS } from "./legacy-config-migrations.runtime.providers.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT } from "./legacy-config-migrations.runtime.system-agent.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS } from "./legacy-config-migrations.runtime.tts.js";

/** Ordered runtime legacy config migrations applied by doctor. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME: LegacyConfigMigrationSpec[] = [
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_AGENTS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_GATEWAY,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_TTS,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES,
];
