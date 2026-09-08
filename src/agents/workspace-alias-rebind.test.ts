import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  detectRepointedWorkspaceAlias,
  rebindRepointedWorkspaceAlias,
} from "./workspace-alias-rebind.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";
import {
  clearExpiredWorkspaceStateForVanishedWorkspace,
  deleteWorkspaceState,
  mergeWorkspaceSetupState,
  prepareWorkspaceStateDeletion,
  readWorkspaceStateSnapshot,
  replaceWorkspaceAttestation,
  WORKSPACE_ATTESTATION_RECENT_MS,
} from "./workspace-state-store.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "workspace-move-" });
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});

function link(target: string, alias: string) {
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}
function repoint(alias: string, target: string) {
  fs.unlinkSync(alias);
  link(target, alias);
}
function movedWorkspace(attestationOnly = false) {
  const original = state.workspaceDir;
  const alias = state.path("workspace-link");
  const moved = state.path("moved-workspace");
  link(original, alias);
  fs.writeFileSync(path.join(original, "project.txt"), "user content");
  if (!attestationOnly) {
    mergeWorkspaceSetupState(
      alias,
      {
        bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
        setupCompletedAt: "2026-07-16T02:00:00.000Z",
      },
      1000,
    );
  }
  replaceWorkspaceAttestation({
    workspaceDir: alias,
    attestedAtMs: 1000,
    generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
    nowMs: 1000,
  });
  fs.renameSync(original, moved);
  repoint(alias, moved);
  return { original, alias, moved };
}

describe("workspace move recovery", () => {
  it("finds a repointed alias with decomposed Unicode in its own name", async () => {
    const original = state.workspaceDir;
    const alias = state.path("alias-e\u0301");
    const moved = state.path("unicode-alias-moved");
    link(original, alias);
    mergeWorkspaceSetupState(alias, { setupCompletedAt: "2026-07-16T02:00:00.000Z" });
    fs.renameSync(original, moved);
    repoint(alias, moved);
    const facts = detectRepointedWorkspaceAlias(alias);
    expect(facts).toBeDefined();
    expect(await rebindRepointedWorkspaceAlias(alias, facts!)).toBe("rebound");
    expect(readWorkspaceStateSnapshot(alias).setup.setupCompletedAt).toBe(
      "2026-07-16T02:00:00.000Z",
    );
  });

  it("recovers when the original configured directory becomes the moved directory's alias", async () => {
    const original = state.workspaceDir;
    const moved = state.path("direct-move");
    mergeWorkspaceSetupState(original, { setupCompletedAt: "2026-07-16T02:00:00.000Z" });
    fs.renameSync(original, moved);
    link(moved, original);
    expect(
      await rebindRepointedWorkspaceAlias(original, detectRepointedWorkspaceAlias(original)!),
    ).toBe("rebound");
    expect(readWorkspaceStateSnapshot(original).setup.setupCompletedAt).toBe(
      "2026-07-16T02:00:00.000Z",
    );
  });

  it.each(["original-e\u0301", "parent-e\u0301/original-\u00e9", "parent-\u00e9/original-e\u0301"])(
    "retains ownership when Unicode original %s still exists",
    async (relative) => {
      const original = state.path(relative);
      const alias = state.path("unicode-link");
      const moved = state.path("unicode-copy");
      fs.mkdirSync(original, { recursive: true });
      fs.mkdirSync(moved);
      link(original, alias);
      mergeWorkspaceSetupState(alias, { setupCompletedAt: "2026-07-16T02:00:00.000Z" });
      repoint(alias, moved);
      expect(
        await rebindRepointedWorkspaceAlias(alias, detectRepointedWorkspaceAlias(alias)!),
      ).toBe("original-workspace-exists");
      expect(readWorkspaceStateSnapshot(original).setup.setupCompletedAt).toBe(
        "2026-07-16T02:00:00.000Z",
      );
      expect(readWorkspaceStateSnapshot(moved).setupExists).toBe(false);
    },
  );

  it("refuses a surviving Unicode sibling even when the normalized spelling points at the destination", async ({
    skip,
  }) => {
    const original = state.path("original-e\u0301");
    const normalized = original.normalize("NFC");
    const alias = state.path("unicode-link");
    const moved = state.path("unicode-copy");
    fs.mkdirSync(original);
    fs.mkdirSync(moved);
    link(original, alias);
    mergeWorkspaceSetupState(alias, { setupCompletedAt: "2026-07-16T02:00:00.000Z" });
    if (fs.existsSync(normalized)) {
      skip();
    }
    link(moved, normalized);
    repoint(alias, moved);
    expect(await rebindRepointedWorkspaceAlias(alias, detectRepointedWorkspaceAlias(alias)!)).toBe(
      "original-workspace-exists",
    );
    expect(readWorkspaceStateSnapshot(moved).setupExists).toBe(false);
  });

  it.each([false, true])(
    "preserves setup and attestation without changing files (attestation only: %s)",
    async (attestationOnly) => {
      const { alias, moved } = movedWorkspace(attestationOnly);
      const facts = detectRepointedWorkspaceAlias(alias)!;
      expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("rebound");
      const snapshot = readWorkspaceStateSnapshot(alias);
      expect(snapshot.setupExists).toBe(!attestationOnly);
      if (!attestationOnly) {
        expect(snapshot.setup).toMatchObject({
          bootstrapSeededAt: "2026-07-16T01:00:00.000Z",
          setupCompletedAt: "2026-07-16T02:00:00.000Z",
        });
      }
      expect(snapshot.attestation).toEqual({
        attestedAtMs: 1000,
        generatedHashes: new Map([["AGENTS.md", "a".repeat(64)]]),
      });
      expect(fs.readFileSync(path.join(moved, "project.txt"), "utf8")).toBe("user content");
      expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("no-repoint");
      closeOpenClawStateDatabaseForTest();
      expect(readWorkspaceStateSnapshot(alias)).toEqual(snapshot);
    },
  );

  it("refuses a copy while the original folder still exists", async () => {
    const { original, alias, moved } = movedWorkspace();
    fs.mkdirSync(original);
    const before = detectRepointedWorkspaceAlias(alias)!;
    expect(await rebindRepointedWorkspaceAlias(alias, before)).toBe("original-workspace-exists");
    expect(readWorkspaceStateSnapshot(original).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(moved).setupExists).toBe(false);
  });

  it("does not merge an existing destination owner and still reports a typed repair failure", async () => {
    const { original, alias, moved } = movedWorkspace();
    mergeWorkspaceSetupState(moved, { bootstrapSeededAt: "2026-07-17T01:00:00.000Z" }, 2000);
    const facts = detectRepointedWorkspaceAlias(alias)!;
    expect(() => readWorkspaceStateSnapshot(alias)).toThrow(WorkspaceAliasRepointedError);
    expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("current-target-owns-state");
    expect(readWorkspaceStateSnapshot(original).setup.setupCompletedAt).toBe(
      "2026-07-16T02:00:00.000Z",
    );
    expect(readWorkspaceStateSnapshot(moved).setup.bootstrapSeededAt).toBe(
      "2026-07-17T01:00:00.000Z",
    );
  });

  it("rejects changed setup records after confirmation facts were read", async () => {
    const { original, alias, moved } = movedWorkspace();
    const facts = detectRepointedWorkspaceAlias(alias)!;
    mergeWorkspaceSetupState(original, {}, 3000);
    expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("repoint-changed");
    expect(readWorkspaceStateSnapshot(moved).setupExists).toBe(false);
  });

  it("rejects a replacement directory at the same approved path", async () => {
    const { alias, moved } = movedWorkspace();
    const facts = detectRepointedWorkspaceAlias(alias)!;
    fs.renameSync(moved, state.path("retained-content"));
    fs.mkdirSync(moved);
    expect(await rebindRepointedWorkspaceAlias(alias, facts)).toBe("repoint-changed");
    expect(readWorkspaceStateSnapshot(moved).setupExists).toBe(false);
  });

  it("uses actual directory bytes when a moved path has decomposed Unicode", async () => {
    const { alias, moved } = movedWorkspace();
    const decomposed = state.path("move-e\u0301");
    fs.renameSync(moved, decomposed);
    repoint(alias, decomposed);
    expect(await rebindRepointedWorkspaceAlias(alias, detectRepointedWorkspaceAlias(alias)!)).toBe(
      "rebound",
    );
    expect(readWorkspaceStateSnapshot(alias).setup.setupCompletedAt).toBe(
      "2026-07-16T02:00:00.000Z",
    );
    expect(fs.readFileSync(path.join(decomposed, "project.txt"), "utf8")).toBe("user content");
  });

  it("refuses a configured path that still needs the old owner", async () => {
    const { original, alias, moved } = movedWorkspace();
    const facts = detectRepointedWorkspaceAlias(alias)!;
    expect(await rebindRepointedWorkspaceAlias(alias, facts, {}, [alias, original])).toBe(
      "configured-workspace-conflict",
    );
    expect(readWorkspaceStateSnapshot(original).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(moved).setupExists).toBe(false);
  });

  it("protects a configured alias before its first workspace access", async () => {
    const { original, alias, moved } = movedWorkspace();
    const unused = state.path("unused-link");
    link(original, unused);
    const facts = detectRepointedWorkspaceAlias(alias)!;
    expect(await rebindRepointedWorkspaceAlias(alias, facts, {}, [alias, unused])).toBe(
      "configured-workspace-conflict",
    );
    expect(readWorkspaceStateSnapshot(original).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(moved).setupExists).toBe(false);
  });

  it("keeps verified sibling aliases but removes old paths from the moved owner's cleanup", async () => {
    const original = state.workspaceDir;
    const first = state.path("first-link");
    const second = state.path("second-link");
    const moved = state.path("moved");
    link(original, first);
    link(original, second);
    mergeWorkspaceSetupState(first, { setupCompletedAt: "2026-07-16T02:00:00.000Z" }, 1000);
    readWorkspaceStateSnapshot(second);
    fs.renameSync(original, moved);
    repoint(first, moved);
    repoint(second, moved);
    expect(
      await rebindRepointedWorkspaceAlias(first, detectRepointedWorkspaceAlias(first)!, {}, [
        first,
        second,
      ]),
    ).toBe("rebound");
    const snapshot = readWorkspaceStateSnapshot(second);
    deleteWorkspaceState(prepareWorkspaceStateDeletion(original));
    clearExpiredWorkspaceStateForVanishedWorkspace(
      original,
      WORKSPACE_ATTESTATION_RECENT_MS + 2000,
    );
    expect(readWorkspaceStateSnapshot(first)).toEqual(snapshot);
    fs.mkdirSync(original);
    mergeWorkspaceSetupState(original, { bootstrapSeededAt: "2026-07-18T01:00:00.000Z" }, 4000);
    expect(readWorkspaceStateSnapshot(second)).toEqual(snapshot);
  });

  it("rejects malformed persisted attestation before it can be transferred", () => {
    const { alias } = movedWorkspace();
    openOpenClawStateDatabase()
      .db.prepare("UPDATE workspace_generated_bootstrap_hashes SET filename = '../outside.md'")
      .run();
    expect(() => detectRepointedWorkspaceAlias(alias)).toThrow(
      "workspace attestation hash row is invalid",
    );
  });

  it("fails closed after a second repoint following a committed move", async () => {
    const { alias, moved } = movedWorkspace();
    expect(await rebindRepointedWorkspaceAlias(alias, detectRepointedWorkspaceAlias(alias)!)).toBe(
      "rebound",
    );
    const other = state.path("other");
    fs.mkdirSync(other);
    repoint(alias, other);
    expect(() => readWorkspaceStateSnapshot(alias)).toThrow(WorkspaceAliasRepointedError);
    expect(readWorkspaceStateSnapshot(moved).setupExists).toBe(true);
    expect(readWorkspaceStateSnapshot(other).setupExists).toBe(false);
  });
});
