import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readClawManifestFile } from "../claws/reader.js";
import { listAgentRoles, loadAgentRole, loadAgentTeamPreset } from "./agent-roles.js";

describe("bundled agent roles", () => {
  it("parses every preset role through the real Claw reader and schema", async () => {
    const preset = await loadAgentTeamPreset();
    const roles = new Set([preset.coordinator.role, ...preset.specialists.map(({ role }) => role)]);
    expect(roles).toEqual(new Set(listAgentRoles()));
    for (const role of roles) {
      const source = path.resolve("docs/reference/templates/roles", role, "CLAW.md");
      const read = await readClawManifestFile(source);
      expect(read).toMatchObject({ ok: true, manifest: { agent: { id: role } } });
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
      const read = vi.spyOn(fs, "readFile").mockResolvedValueOnce(JSON.stringify(invalid));
      try {
        await expect(loadAgentTeamPreset()).rejects.toThrow();
      } finally {
        read.mockRestore();
      }
    }
    await expect(loadAgentRole("../researcher")).rejects.toThrow("Available roles:");
    await expect(loadAgentTeamPreset("../team")).rejects.toThrow("Available presets: team");
  });
});
