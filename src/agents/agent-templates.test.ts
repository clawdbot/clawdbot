import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATE_ROLES,
  agentTeamPresetSchema,
  agentTemplateManifestSchema,
} from "./agent-template-schema.js";
import { loadAgentTeamPreset, loadAgentTemplate } from "./agent-templates.js";

describe("bundled agent templates", () => {
  it("loads every role and all preset role references with complete workspace files", async () => {
    const preset = await loadAgentTeamPreset();
    const roles = new Set([preset.coordinator.role, ...preset.specialists.map(({ role }) => role)]);
    expect(roles).toEqual(new Set(AGENT_TEMPLATE_ROLES));
    for (const role of roles) {
      const template = await loadAgentTemplate(role);
      expect(template.manifest.role).toBe(role);
      for (const file of template.manifest.files) {
        expect(template.files[file].trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("rejects unknown keys, unsupported roles, and unsafe or incomplete file references", async () => {
    const { manifest } = await loadAgentTemplate("researcher");
    for (const invalid of [
      { ...manifest, unknown: true },
      { ...manifest, identity: { ...manifest.identity, unknown: true } },
      { ...manifest, subagents: { unknown: true } },
      { ...manifest, role: "unknown" },
      { ...manifest, files: ["../AGENTS.md", "SOUL.md", "IDENTITY.md"] },
      { ...manifest, files: ["AGENTS.md", "SOUL.md", "SOUL.md"] },
      { ...manifest, files: ["AGENTS.md"] },
      { ...manifest, subagents: { allowAgents: ["../researcher"] } },
    ]) {
      expect(agentTemplateManifestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects preset typos, unresolved role references, and colliding ids", async () => {
    const preset = await loadAgentTeamPreset();
    for (const invalid of [
      { ...preset, unknown: true },
      { ...preset, coordinator: { ...preset.coordinator, unknown: true } },
      { ...preset, specialists: [{ id: "worker", role: "missing-role" }] },
      { ...preset, specialists: [{ id: preset.coordinator.id, role: "researcher" }] },
    ]) {
      expect(agentTeamPresetSchema.safeParse(invalid).success).toBe(false);
    }
    await expect(loadAgentTemplate("../researcher")).rejects.toThrow("Available roles:");
    await expect(loadAgentTeamPreset("../team")).rejects.toThrow("Available presets: team");
  });
});
