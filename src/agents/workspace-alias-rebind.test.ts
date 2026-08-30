// Detection and non-destructive rebind of repointed workspace aliases.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "./workspace-alias-rebind.js";
import { resolveWorkspaceStateIdentity } from "./workspace-state-identity.js";
import {
  mergeWorkspaceSetupState,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
} from "./workspace-state-store.js";

let testState: OpenClawTestState | undefined;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workspace-alias-rebind-",
  });
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState?.cleanup();
  testState = undefined;
});

describe("workspace alias rebind", () => {
  it("detects and rebinds a repointed alias without touching workspace files", () => {
    const dir = testState!.workspaceDir;
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.writeFileSync(path.join(replacement, "kept.txt"), "moved workspace content");
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    replaceWorkspaceAttestation({
      workspaceDir: alias,
      attestedAtMs: 1_000,
      generatedHashes: new Map([["BOOTSTRAP.md", "a".repeat(64)]]),
      nowMs: 1_000,
    });
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    const facts = detectRepointedWorkspaceAlias(alias);
    expect(facts).toMatchObject({
      storedWorkspacePath: resolveWorkspaceStateIdentity(dir).workspacePath,
      currentWorkspacePath: resolveWorkspaceStateIdentity(replacement).workspacePath,
      currentTargetHasOwnState: false,
    });
    expect(facts?.storedAttestationHashes.get("BOOTSTRAP.md")).toBe("a".repeat(64));

    expect(rebindRepointedWorkspaceAlias(alias)).toBe("rebound");
    const snapshot = readWorkspaceStateSnapshot(alias);
    expect(snapshot.setupExists).toBe(true);
    expect(snapshot.setup.bootstrapSeededAt).toBe("2026-07-16T01:00:00.000Z");
    expect(snapshot.attestation?.generatedHashes.get("BOOTSTRAP.md")).toBe("a".repeat(64));
    expect(fs.readFileSync(path.join(replacement, "kept.txt"), "utf-8")).toBe(
      "moved workspace content",
    );

    expect(detectRepointedWorkspaceAlias(alias)).toBeUndefined();
    expect(rebindRepointedWorkspaceAlias(alias)).toBe("no-repoint");
  });

  it("refuses to rebind onto a target that already owns workspace state", () => {
    const dir = testState!.workspaceDir;
    const alias = testState!.path("workspace-link");
    const replacement = testState!.path("replacement-workspace");
    fs.mkdirSync(replacement, { recursive: true });
    fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
    mergeWorkspaceSetupState(alias, { bootstrapSeededAt: "2026-07-16T01:00:00.000Z" }, 1_000);
    mergeWorkspaceSetupState(replacement, { bootstrapSeededAt: "2026-07-16T02:00:00.000Z" }, 2_000);
    fs.unlinkSync(alias);
    fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");

    expect(detectRepointedWorkspaceAlias(alias)?.currentTargetHasOwnState).toBe(true);
    expect(rebindRepointedWorkspaceAlias(alias)).toBe("current-target-owns-state");
    expect(readWorkspaceStateSnapshot(dir).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(replacement).setupExists).toBe(true);
  });
});
