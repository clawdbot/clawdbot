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
