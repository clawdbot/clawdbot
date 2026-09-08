import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function migrateUiAssistant(raw: Record<string, unknown>) {
  const changes: string[] = [];
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED.find(
    (candidate) => candidate.id === "runtime.ui-assistant-identity",
  );
  expect(migration).toBeDefined();
  migration?.apply(raw, changes);
  return { raw, changes };
}

describe("retired UI assistant identity migration", () => {
  it("removes the override without changing agent identity", () => {
    const result = migrateUiAssistant({
      ui: {
        seamColor: "#ff4500",
        assistant: { name: "UI name", avatar: "avatars/ui.png" },
      },
      agents: {
        list: [
          { id: "worker", identity: { name: "Worker" } },
          { id: "primary", default: true, identity: { name: "Main", emoji: "🦞" } },
        ],
      },
    });

    expect(result.raw).toMatchObject({
      ui: { seamColor: "#ff4500" },
      agents: {
        list: [
          { id: "worker", identity: { name: "Worker" } },
          { id: "primary", default: true, identity: { name: "Main", emoji: "🦞" } },
        ],
      },
    });
    expect(result.raw).not.toHaveProperty("ui.assistant");
    expect(result.changes).toContain(
      "Removed retired ui.assistant; configure agents.list[].identity instead.",
    );
  });

  it("does not create an agent identity", () => {
    const result = migrateUiAssistant({
      ui: { assistant: { name: "OpenClaw", avatar: "🦞" } },
    });

    expect(result.raw).toEqual({});
  });
});
