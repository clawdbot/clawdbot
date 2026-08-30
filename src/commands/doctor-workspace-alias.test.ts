// Doctor repair for repointed workspace aliases: detection, evidence-gated
// rebind, and refusal when the current target owns its own state.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "../agents/workspace-state-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import {
  collectRepointedWorkspaceAliasFindings,
  maybeRepairRepointedWorkspaceAliases,
} from "./doctor-workspace-alias.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-workspace-alias-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

function buildPrompter(overrides: Partial<DoctorPrompter> = {}): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => true),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: true,
    shouldForce: false,
    repairMode: {
      shouldRepair: true,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
    } as DoctorPrompter["repairMode"],
    ...overrides,
  };
}

function buildAliasCfg(aliasPath: string): OpenClawConfig {
  return { agents: { entries: { main: { workspace: aliasPath } } } } as OpenClawConfig;
}

function repointAlias(params: { seedAttestedFile?: boolean }): {
  alias: string;
  original: string;
  replacement: string;
} {
  const original = testState!.workspaceDir;
  const alias = testState!.path("workspace-link");
  const replacement = testState!.path("replacement-workspace");
  fs.mkdirSync(replacement, { recursive: true });
  fs.symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
  mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
  if (params.seedAttestedFile) {
    const content = "seeded bootstrap content";
    fs.writeFileSync(path.join(replacement, "BOOTSTRAP.md"), content);
    replaceWorkspaceAttestation({
      workspaceDir: alias,
      attestedAtMs: 1_000,
      generatedHashes: new Map([
        ["BOOTSTRAP.md", crypto.createHash("sha256").update(content).digest("hex")],
      ]),
      nowMs: 1_000,
    });
  }
  fs.unlinkSync(alias);
  fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
  return { alias, original, replacement };
}

describe("doctor workspace alias repair", () => {
  it("reports a repointed alias as a warning finding", () => {
    const { alias } = repointAlias({ seedAttestedFile: false });

    const findings = collectRepointedWorkspaceAliasFindings(buildAliasCfg(alias));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "core/doctor/workspace-alias",
      severity: "warning",
      fixHint: expect.stringContaining("doctor --fix"),
    });
  });

  it("reports nothing when aliases are intact", () => {
    const dir = testState!.workspaceDir;
    mergeWorkspaceSetupState(dir, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);

    expect(collectRepointedWorkspaceAliasFindings(buildAliasCfg(dir))).toHaveLength(0);
  });

  it("rebinds automatically when attested files verify against the current target", async () => {
    const { alias } = repointAlias({ seedAttestedFile: true });
    const prompter = buildPrompter();

    await maybeRepairRepointedWorkspaceAliases({ cfg: buildAliasCfg(alias), prompter });

    expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
    expect(prompter.confirmAggressiveAutoFix).not.toHaveBeenCalled();
    const snapshot = readWorkspaceStateSnapshot(alias);
    expect(snapshot.setupExists).toBe(true);
    expect(snapshot.setup.bootstrapSeededAt).toBe("2026-07-16T01:00:00.000Z");

    // A second run finds nothing left to repair.
    const secondPrompter = buildPrompter();
    await maybeRepairRepointedWorkspaceAliases({
      cfg: buildAliasCfg(alias),
      prompter: secondPrompter,
    });
    expect(secondPrompter.confirmAutoFix).not.toHaveBeenCalled();
  });

  it("requires the explicit operator gate when continuity is unproven", async () => {
    const { alias, original } = repointAlias({ seedAttestedFile: false });
    const prompter = buildPrompter();

    await maybeRepairRepointedWorkspaceAliases({ cfg: buildAliasCfg(alias), prompter });

    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(prompter.confirmAggressiveAutoFix).toHaveBeenCalledOnce();
    // Declined: stored state stays with the original canonical target.
    expect(readWorkspaceStateSnapshot(original).setupExists).toBe(true);

    const approving = buildPrompter({ confirmAggressiveAutoFix: vi.fn(async () => true) });
    await maybeRepairRepointedWorkspaceAliases({ cfg: buildAliasCfg(alias), prompter: approving });
    expect(readWorkspaceStateSnapshot(alias).setupExists).toBe(true);
  });

  it("refuses to merge when the current target already owns state", async () => {
    const { alias, original, replacement } = repointAlias({ seedAttestedFile: false });
    mergeWorkspaceSetupState(replacement, { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" }, 2_000);
    const prompter = buildPrompter({ confirmAggressiveAutoFix: vi.fn(async () => true) });

    await maybeRepairRepointedWorkspaceAliases({ cfg: buildAliasCfg(alias), prompter });

    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(prompter.confirmAggressiveAutoFix).not.toHaveBeenCalled();
    expect(readWorkspaceStateSnapshot(original).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(replacement).setupExists).toBe(true);
  });

  it("only notes the problem outside repair mode", async () => {
    const { alias, original } = repointAlias({ seedAttestedFile: true });
    const prompter = buildPrompter({ shouldRepair: false });

    await maybeRepairRepointedWorkspaceAliases({ cfg: buildAliasCfg(alias), prompter });

    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
    expect(readWorkspaceStateSnapshot(original).setupExists).toBe(true);
  });
});
