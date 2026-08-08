// Tests for the extra-bootstrap glob-escape doctor migration: it must escape a
// pattern that named a literal on-disk directory whose name now reads as a glob,
// be idempotent, never over-escape a genuine glob, and no-op on a healthy config.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

import { loadExtraBootstrapFilesWithDiagnostics } from "../agents/workspace.js";
import {
  collectExtraBootstrapGlobEscapeFindings,
  maybeEscapeExtraBootstrapGlobs,
} from "./doctor-extra-bootstrap-glob-escape-migration.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-glob-escape-")));
  tempRoots.push(dir);
  return dir;
}

function configWith(workspace: string, patterns: string[]): OpenClawConfig {
  return {
    agents: { list: [{ id: "main", default: true, workspace }] },
    hooks: { internal: { entries: { "bootstrap-extra-files": { paths: patterns } } } },
  } as unknown as OpenClawConfig;
}

function configWithAgents(
  workspaces: { id: string; workspace: string; default?: boolean }[],
  patterns: string[],
): OpenClawConfig {
  return {
    agents: { list: workspaces },
    hooks: { internal: { entries: { "bootstrap-extra-files": { paths: patterns } } } },
  } as unknown as OpenClawConfig;
}

function patternsOf(cfg: OpenClawConfig): unknown {
  return (
    cfg.hooks?.internal?.entries?.["bootstrap-extra-files"] as { paths?: unknown } | undefined
  )?.paths;
}

describe("extra bootstrap glob escape migration", () => {
  it("escapes a literal bracketed directory pattern and keeps it loading", async () => {
    const workspace = await makeWorkspace();
    const dir = path.join(workspace, "pkg[ab]");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "literal agents", "utf-8");
    const cfg = configWith(workspace, ["pkg[ab]/AGENTS.md"]);

    const findings = await collectExtraBootstrapGlobEscapeFindings(cfg);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "core/doctor/extra-bootstrap-glob-escape",
      requirement: "extra-bootstrap-literal-glob-escape",
    });

    // Preview mode must not mutate the config.
    const preview = await maybeEscapeExtraBootstrapGlobs({ cfg, shouldRepair: false });
    expect(preview.changes).toHaveLength(0);
    expect(patternsOf(preview.cfg)).toStrictEqual(["pkg[ab]/AGENTS.md"]);

    // Repair mode rewrites to the escaped literal form.
    const repaired = await maybeEscapeExtraBootstrapGlobs({ cfg, shouldRepair: true });
    expect(repaired.changes).toHaveLength(1);
    expect(patternsOf(repaired.cfg)).toStrictEqual(["pkg[[]ab[]]/AGENTS.md"]);

    // End-to-end: the escaped pattern loads the real file again, the original does not.
    const original = await loadExtraBootstrapFilesWithDiagnostics(workspace, ["pkg[ab]/AGENTS.md"]);
    expect(original.files).toHaveLength(0);
    const escaped = await loadExtraBootstrapFilesWithDiagnostics(workspace, [
      "pkg[[]ab[]]/AGENTS.md",
    ]);
    expect(escaped.files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(dir, "AGENTS.md"),
        content: "literal agents",
        missing: false,
      },
    ]);
  });

  it("is idempotent: a second run makes no further change", async () => {
    const workspace = await makeWorkspace();
    const dir = path.join(workspace, "pkg[ab]");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "literal agents", "utf-8");
    const cfg = configWith(workspace, ["pkg[ab]/AGENTS.md"]);

    const first = await maybeEscapeExtraBootstrapGlobs({ cfg, shouldRepair: true });
    expect(patternsOf(first.cfg)).toStrictEqual(["pkg[[]ab[]]/AGENTS.md"]);

    const second = await maybeEscapeExtraBootstrapGlobs({
      cfg: first.cfg,
      shouldRepair: true,
    });
    expect(second.changes).toHaveLength(0);
    expect(second.cfg).toBe(first.cfg);
    expect(patternsOf(second.cfg)).toStrictEqual(["pkg[[]ab[]]/AGENTS.md"]);
  });

  it("does not over-escape a genuine glob that matches files", async () => {
    const workspace = await makeWorkspace();
    const dir = path.join(workspace, "packages", "core");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "real agents", "utf-8");
    const cfg = configWith(workspace, ["**/*.md", "packages/*/AGENTS.md"]);

    const findings = await collectExtraBootstrapGlobEscapeFindings(cfg);
    expect(findings).toHaveLength(0);
    const repaired = await maybeEscapeExtraBootstrapGlobs({ cfg, shouldRepair: true });
    expect(repaired.changes).toHaveLength(0);
    expect(patternsOf(repaired.cfg)).toStrictEqual(["**/*.md", "packages/*/AGENTS.md"]);
  });

  it("keeps both agents loading when two workspaces share a bracket pattern", async () => {
    // Coexistence: one hook config is shared by every agent, but each agent has
    // its own workspace. Workspace A has a real directory literally named
    // `pkg[ab]`; Workspace B has `pkga`, so the SAME pattern `pkg[ab]/AGENTS.md`
    // is a live glob for B and a mislabeled literal for A. A naive replace would
    // only move the silent-drop victim from A to B — so the migration keeps the
    // original glob AND adds the escaped literal alongside it.
    const workspaceA = await makeWorkspace();
    const workspaceB = await makeWorkspace();
    const dirA = path.join(workspaceA, "pkg[ab]");
    await fs.mkdir(dirA, { recursive: true });
    await fs.writeFile(path.join(dirA, "AGENTS.md"), "literal a", "utf-8");
    const dirB = path.join(workspaceB, "pkga");
    await fs.mkdir(dirB, { recursive: true });
    await fs.writeFile(path.join(dirB, "AGENTS.md"), "glob b", "utf-8");
    const cfg = configWithAgents(
      [
        { id: "a", default: true, workspace: workspaceA },
        { id: "b", workspace: workspaceB },
      ],
      ["pkg[ab]/AGENTS.md"],
    );

    // A finding is emitted so the operator sees a diagnostic, not a silent skip.
    const findings = await collectExtraBootstrapGlobEscapeFindings(cfg);
    expect(findings).toHaveLength(1);

    const repaired = await maybeEscapeExtraBootstrapGlobs({ cfg, shouldRepair: true });
    expect(repaired.changes).toHaveLength(1);
    // Both entries coexist: the untouched glob (for B) and the escaped literal (for A).
    expect(patternsOf(repaired.cfg)).toStrictEqual(["pkg[ab]/AGENTS.md", "pkg[[]ab[]]/AGENTS.md"]);

    // Idempotent: a second run finds the escaped form already present.
    const second = await maybeEscapeExtraBootstrapGlobs({
      cfg: repaired.cfg,
      shouldRepair: true,
    });
    expect(second.changes).toHaveLength(0);
    expect(second.cfg).toBe(repaired.cfg);
    expect(patternsOf(second.cfg)).toStrictEqual(["pkg[ab]/AGENTS.md", "pkg[[]ab[]]/AGENTS.md"]);

    // End-to-end: with both patterns configured, each agent loads its own file —
    // A via the escaped literal, B via the still-live glob.
    const repairedPatterns = patternsOf(repaired.cfg) as string[];
    const loadedA = await loadExtraBootstrapFilesWithDiagnostics(workspaceA, repairedPatterns);
    expect(loadedA.files).toContainEqual({
      name: "AGENTS.md",
      path: path.join(dirA, "AGENTS.md"),
      content: "literal a",
      missing: false,
    });
    const loadedB = await loadExtraBootstrapFilesWithDiagnostics(workspaceB, repairedPatterns);
    expect(loadedB.files).toContainEqual({
      name: "AGENTS.md",
      path: path.join(dirB, "AGENTS.md"),
      content: "glob b",
      missing: false,
    });
  });

  it("no-ops when the configured patterns are already correct", async () => {
    const workspace = await makeWorkspace();
    const dir = path.join(workspace, "pkg[ab]");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), "literal agents", "utf-8");
    // A plain literal path and the already-escaped bracket form both need no work.
    const cfg = configWith(workspace, ["packages/core/AGENTS.md", "pkg[[]ab[]]/AGENTS.md"]);

    const findings = await collectExtraBootstrapGlobEscapeFindings(cfg);
    expect(findings).toHaveLength(0);
    const repaired = await maybeEscapeExtraBootstrapGlobs({ cfg, shouldRepair: true });
    expect(repaired.changes).toHaveLength(0);
    expect(repaired.cfg).toBe(cfg);
  });
});
