import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON } from "./legacy-config-migrations.runtime.cron.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP } from "./legacy-config-migrations.runtime.mcp.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS } from "./legacy-config-migrations.runtime.models.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION } from "./legacy-config-migrations.runtime.session.js";

function applyAll(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of [
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MCP,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.filter(
      (modelMigration) => modelMigration.id === "defaultModel->agents.defaults.model",
    ),
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_SESSION,
    ...LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED,
  ]) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

describe("retired runtime config migrations", () => {
  it("moves aliases and strips dead keys", () => {
    const result = applyAll({
      tui: { footer: { showRemoteHost: true } },
      defaultModel: "openai/gpt-5.6",
      commands: { modelsWrite: true },
      messages: { messagePrefix: "[wa]" },
      cron: { webhook: "https://example.com", webhookToken: "keep" },
      session: { maintenance: { pruneDays: 7 }, resetByType: { dm: { mode: "idle" } } },
      talk: { realtime: { voice: "alloy" } },
      mcp: { servers: { docs: { connectTimeout: 2, timeout: 3 } } },
      nodeHost: { mcp: { servers: { local: { connect_timeout: 4 } } } },
      tools: {
        media: {
          asyncCompletion: { directSend: true },
          audio: { deepgram: { smartFormat: true } },
        },
        message: { allowCrossContextSend: true },
      },
    });

    expect(result.raw).toMatchObject({
      channels: { whatsapp: { messagePrefix: "[wa]" } },
      agents: { defaults: { model: "openai/gpt-5.6" } },
      cron: { webhookToken: "keep" },
      session: { maintenance: { pruneAfter: 7 }, resetByType: { direct: { mode: "idle" } } },
      talk: { realtime: { speakerVoice: "alloy" } },
      mcp: { servers: { docs: { connectionTimeoutMs: 2000, requestTimeoutMs: 3000 } } },
      nodeHost: { mcp: { servers: { local: { connectionTimeoutMs: 4000 } } } },
      tools: {
        media: { audio: { providerOptions: { deepgram: { smart_format: true } } } },
        message: { crossContext: { allowWithinProvider: true, allowAcrossProviders: true } },
      },
    });
    expect(result.raw).not.toHaveProperty("tui");
    expect(result.raw).not.toHaveProperty("commands.modelsWrite");
    expect(result.changes.length).toBeGreaterThan(8);
  });
});
