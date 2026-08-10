import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { afterEach, describe, expect, it } from "vitest";
import { scopedMemoryMigrationPreview } from "./doctor-scoped-memory-preview.js";

describe("scoped memory doctor dry-run", () => {
  const roots = new Set<string>();

  afterEach(() => {
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    roots.clear();
  });

  function root(): string {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scoped-memory-doctor-"));
    roots.add(value);
    return value;
  }

  function params(
    config: OpenClawConfig,
    stateDir: string,
  ): Parameters<typeof scopedMemoryMigrationPreview.detectLegacyState>[0] {
    return {
      config,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      env: {},
      context: {} as PluginDoctorStateMigrationContext,
    };
  }

  it("is deterministic, redacted, and leaves legacy sources untouched", async () => {
    const fixture = root();
    const stateDir = path.join(fixture, "state");
    const workspace = path.join(fixture, "workspace");
    const sessions = path.join(stateDir, "agents", "main", "sessions");
    fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), "private curated content");
    fs.writeFileSync(path.join(workspace, "memory", "private-memory.md"), "private memory content");
    fs.writeFileSync(path.join(sessions, "turn.jsonl"), '{"content":"private transcript"}\n');
    fs.writeFileSync(path.join(sessions, "sessions.json"), '{"private":"metadata"}\n');
    const config = {
      session: { dmScope: "main" },
      agents: { list: [{ id: "main", workspace, sandbox: { mode: "all" } }] },
    } as OpenClawConfig;
    const input = params(config, stateDir);
    const before = fs.readdirSync(fixture, { recursive: true }).sort();

    const first = await scopedMemoryMigrationPreview.detectLegacyState(input);
    const second = await scopedMemoryMigrationPreview.detectLegacyState(input);
    const apply = await scopedMemoryMigrationPreview.migrateLegacyState(input);

    expect(second).toEqual(first);
    expect(apply.changes).toEqual([]);
    expect(apply.warnings).toEqual([]);
    expect(apply.notices).toEqual(first?.preview);
    const report = JSON.stringify({ first, apply });
    expect(report).toContain("curated=1, memory=1, transcripts=1");
    expect(report).toContain("dmScope=1, backend=1, filesystem=0, sandbox=1");
    expect(report).toContain("classify -> backup -> copy -> reindex -> verify -> cutover");
    expect(report).not.toContain("private curated content");
    expect(report).not.toContain("private-memory.md");
    expect(report).not.toContain("private transcript");
    expect(fs.readdirSync(fixture, { recursive: true }).sort()).toEqual(before);
  });

  it("reports invalid agent identity without touching a traversal-shaped path", async () => {
    const fixture = root();
    const stateDir = path.join(fixture, "state");
    const config = { agents: { list: [{ id: ".." }] } } as OpenClawConfig;

    const preview = await scopedMemoryMigrationPreview.detectLegacyState(params(config, stateDir));

    expect(preview?.preview.join("\n")).toContain("invalidAgent=1");
    expect(fs.existsSync(path.join(fixture, "sessions"))).toBe(false);
  });

  it("uses canonical entries precedence and counts symlinked legacy files as blockers", async () => {
    const fixture = root();
    const stateDir = path.join(fixture, "state");
    const workspace = path.join(fixture, "workspace");
    fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "MEMORY.md"), "canonical workspace content");
    fs.symlinkSync(path.join(workspace, "MEMORY.md"), path.join(workspace, "memory", "link.md"));
    const config = {
      agents: {
        // `entries` intentionally wins over a malformed legacy list, matching the core roster reader.
        entries: { main: { workspace } },
        list: [{ id: "..", workspace: path.join(fixture, "ignored") }],
      },
    } as OpenClawConfig;

    const preview = await scopedMemoryMigrationPreview.detectLegacyState(params(config, stateDir));
    const report = preview?.preview.join("\n") ?? "";

    expect(report).toContain("curated=1, memory=0, transcripts=0");
    expect(report).toContain("filesystem=1");
    expect(report).toContain("invalidAgent=0");
    expect(report).not.toContain("canonical workspace content");
    expect(fs.existsSync(path.join(fixture, "ignored"))).toBe(false);
  });
});
