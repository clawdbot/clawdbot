import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedSkillUsedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { loadSkills } from "../loading/session.js";
import {
  buildWorkspaceSkillSnapshot,
  loadVisibleWorkspaceSkillEntries,
} from "../loading/workspace.js";
import type {
  SkillProposalManifest,
  SkillProposalManifestEntry,
  SkillProposalRecord,
} from "./types.js";

const store = vi.hoisted(() => ({
  entries: [] as SkillProposalManifestEntry[],
  records: new Map<string, SkillProposalRecord>(),
  readManifest: vi.fn(),
  readRecord: vi.fn(),
}));

vi.mock("./store.js", () => ({
  readSkillProposalManifest: store.readManifest,
  readSkillProposalRecord: store.readRecord,
}));

import {
  getSkillCuratorDoctorWarning,
  getSkillCuratorStatus,
  pinCuratedSkill,
  restoreCuratedSkill,
  startSkillCuratorMaintenance,
  unpinCuratedSkill,
} from "./curator.js";

const STALE_AFTER_MS = 30 * 24 * 60 * 60_000;
const ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60_000;
const CURATOR_INITIAL_DELAY_MS = 5 * 60_000;
const DOCTOR_WEDGED_AFTER_MS = 7 * 24 * 60 * 60_000;

let rootDir = "";
let stateDir = "";
let originalStateDir: string | undefined;

function registerSkillUsageTracking(): () => void {
  return startSkillCuratorMaintenance({
    onError: (error) => {
      throw error;
    },
    runSweep: async () => undefined,
  });
}

async function recordSkillUsage(event: {
  skillFile: string;
  skillName: string;
  skillSource: "bundled" | "unknown" | "workspace";
  agentId?: string;
  ts: number;
}): Promise<void> {
  const cleanup = registerSkillUsageTracking();
  const now = vi.spyOn(Date, "now").mockReturnValue(event.ts);
  try {
    emitTrustedSkillUsedDiagnosticEvent(
      {
        type: "skill.used",
        skillName: event.skillName,
        skillSource: event.skillSource,
        activation: "read",
        agentId: event.agentId,
      },
      { skillUsage: { skillFile: event.skillFile } },
    );
  } finally {
    now.mockRestore();
  }
  await waitForDiagnosticEventsDrained();
  cleanup();
}

async function runSkillCuratorSweep(options: {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(nowMs - CURATOR_INITIAL_DELAY_MS);
  let failure: unknown;
  const cleanup = startSkillCuratorMaintenance({
    onError: (error) => {
      failure = error;
    },
    registerUsageTracking: () => () => undefined,
  });
  try {
    await vi.advanceTimersByTimeAsync(CURATOR_INITIAL_DELAY_MS);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = getSkillCuratorStatus({ env: process.env });
      if (failure || status.lastSuccessAtMs === nowMs || status.lastError) {
        break;
      }
      await Promise.resolve();
    }
  } finally {
    cleanup();
    vi.useRealTimers();
  }
  if (failure) {
    throw failure instanceof Error
      ? failure
      : new Error("skill curator sweep failed", { cause: failure });
  }
}

function readSkillUsageFiles(): string[] {
  const database = openOpenClawStateDatabase({ env: process.env });
  const kysely = getNodeSqliteKysely<Pick<OpenClawStateDatabase, "skill_usage">>(database.db);
  return executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("skill_usage").select("skill_file").orderBy("skill_file", "asc"),
  ).rows.map((row) => row.skill_file);
}

function addAppliedSkill(params: {
  name: string;
  appliedAtMs: number;
  createdBy?: SkillProposalRecord["createdBy"];
  description?: string;
  proposalId?: string;
  agentDirName?: string;
  kind?: SkillProposalRecord["kind"];
}): void {
  const skillKey = params.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
  const kind = params.kind ?? "create";
  const id = params.proposalId ?? `${skillKey}-${kind}-proposal`;
  const timestamp = new Date(params.appliedAtMs).toISOString();
  const description = params.description ?? `${params.name} workflow`;
  store.entries.push({
    id,
    kind,
    status: "applied",
    title: params.name,
    description,
    skillName: params.name,
    skillKey,
    createdAt: timestamp,
    updatedAt: timestamp,
    scanState: "clean",
  });
  store.records.set(id, {
    schema: "openclaw.skill-workshop.proposal.v1",
    id,
    kind,
    status: "applied",
    title: params.name,
    description,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: params.createdBy ?? "skill-workshop",
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: "hash",
    target: {
      skillName: params.name,
      skillKey,
      skillDir: `/skills/${skillKey}`,
      skillFile: path.join(rootDir, params.agentDirName ?? "agent", "skills", skillKey, "SKILL.md"),
    },
    scan: {
      state: "clean",
      scannedAt: timestamp,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    },
    appliedAt: timestamp,
  });
  writeSkill(path.join(rootDir, params.agentDirName ?? "agent"), skillKey, params.name);
}

function writeSkill(agentDir: string, key: string, name: string): void {
  const dir = path.join(agentDir, "skills", key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} workflow\n---\n`,
    "utf8",
  );
}

beforeEach(() => {
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-curator-")));
  stateDir = path.join(rootDir, "state-root");
  fs.mkdirSync(stateDir, { recursive: true });
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  store.entries.length = 0;
  store.records.clear();
  store.readManifest.mockReset().mockImplementation(async () => ({
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: new Date(0).toISOString(),
    proposals: store.entries,
  }));
  store.readRecord.mockReset().mockImplementation(async (id: string) => store.records.get(id));
  resetDiagnosticEventsForTest();
  setDiagnosticsEnabledForProcess(true);
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetDiagnosticEventsForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe("skill curator usage", () => {
  it("upserts trusted usage events and accepts unknown sources", async () => {
    const nowMs = Date.now();
    const skillFile = path.join(rootDir, "agent", "skills", "daily-brief", "SKILL.md");
    addAppliedSkill({ name: "Daily Brief", appliedAtMs: nowMs });
    const unregister = registerSkillUsageTracking();
    emitTrustedSkillUsedDiagnosticEvent(
      {
        type: "skill.used",
        skillName: "Daily Brief",
        skillSource: "unknown",
        activation: "read",
        agentId: "main",
      },
      { skillUsage: { skillFile } },
    );
    setDiagnosticsEnabledForProcess(false);
    emitTrustedSkillUsedDiagnosticEvent(
      {
        type: "skill.used",
        skillName: "Daily Brief",
        skillSource: "workspace",
        activation: "command",
        agentId: "writer",
      },
      { skillUsage: { skillFile } },
    );
    await waitForDiagnosticEventsDrained();
    unregister();

    await runSkillCuratorSweep({ env: process.env, nowMs });
    expect(getSkillCuratorStatus({ env: process.env }).skills[0]).toMatchObject({
      skillKey: "daily-brief",
      useCount: 2,
    });
  });

  it("skips usage events without a canonical skill file", async () => {
    const nowMs = Date.now();
    addAppliedSkill({ name: "Nameless Usage", appliedAtMs: nowMs });
    const unregister = registerSkillUsageTracking();
    emitTrustedSkillUsedDiagnosticEvent({
      type: "skill.used",
      skillName: "Nameless Usage",
      skillSource: "workspace",
      activation: "read",
    });
    await waitForDiagnosticEventsDrained();
    unregister();

    await runSkillCuratorSweep({ env: process.env, nowMs });
    expect(getSkillCuratorStatus({ env: process.env }).skills[0]).toMatchObject({
      skillKey: "nameless-usage",
      useCount: 0,
    });
  });

  it("keeps last-used time monotonic when events arrive out of order", async () => {
    const skillFile = path.join(rootDir, "agent", "skills", "ordered", "SKILL.md");
    addAppliedSkill({ name: "Ordered", appliedAtMs: 0 });
    await recordSkillUsage({
      skillFile,
      skillName: "Ordered",
      skillSource: "workspace",
      agentId: "newer",
      ts: 200,
    });
    await recordSkillUsage({
      skillFile,
      skillName: "Ordered",
      skillSource: "workspace",
      agentId: "older",
      ts: 100,
    });

    await runSkillCuratorSweep({ env: process.env, nowMs: 201 });
    expect(getSkillCuratorStatus({ env: process.env }).skills[0]).toMatchObject({
      lastUsedAtMs: 200,
      useCount: 2,
    });
  });

  it("contains subscriber failures without throwing into the emitter", async () => {
    const unregister = registerSkillUsageTracking();
    expect(() =>
      emitTrustedSkillUsedDiagnosticEvent(
        {
          type: "skill.used",
          skillName: "!!!",
          skillSource: "unknown",
          activation: "read",
        },
        {
          skillUsage: {
            skillFile: path.join(rootDir, "agent", "skills", "invalid", "SKILL.md"),
          },
        },
      ),
    ).not.toThrow();
    await expect(waitForDiagnosticEventsDrained()).resolves.toBeUndefined();
    unregister();
  });
});

describe("skill curator lifecycle", () => {
  it("applies active, stale, archived, and pinned transitions", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    addAppliedSkill({ name: "Fresh", appliedAtMs: nowMs - STALE_AFTER_MS });
    addAppliedSkill({ name: "Stale", appliedAtMs: nowMs - STALE_AFTER_MS - 1 });
    addAppliedSkill({ name: "Archive", appliedAtMs: nowMs - ARCHIVE_AFTER_MS - 1 });

    await runSkillCuratorSweep({ env: process.env, nowMs });
    expect(getSkillCuratorStatus({ env: process.env }).skills).toMatchObject([
      { skillKey: "archive", state: "archived" },
      { skillKey: "fresh", state: "active" },
      { skillKey: "stale", state: "stale" },
    ]);

    pinCuratedSkill("stale", { env: process.env });
    await runSkillCuratorSweep({ env: process.env, nowMs: nowMs + ARCHIVE_AFTER_MS });
    expect(
      getSkillCuratorStatus({ env: process.env }).skills.find(
        (skill) => skill.skillKey === "stale",
      ),
    ).toMatchObject({ state: "stale", pinned: true });
    unpinCuratedSkill("stale", { env: process.env });
  });

  it("reactivates stale use, preserves archives, and restores explicitly", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    addAppliedSkill({ name: "Dormant", appliedAtMs: nowMs - STALE_AFTER_MS - 1 });
    addAppliedSkill({ name: "Deep Archive", appliedAtMs: nowMs - ARCHIVE_AFTER_MS - 1 });
    addAppliedSkill({ name: "Unused Archive", appliedAtMs: nowMs - ARCHIVE_AFTER_MS - 1 });
    await runSkillCuratorSweep({ env: process.env, nowMs });

    await recordSkillUsage({
      skillFile: path.join(rootDir, "agent", "skills", "dormant", "SKILL.md"),
      skillName: "Dormant",
      skillSource: "workspace",
      agentId: "main",
      ts: nowMs + 1,
    });
    await recordSkillUsage({
      skillFile: path.join(rootDir, "agent", "skills", "deep-archive", "SKILL.md"),
      skillName: "Deep Archive",
      skillSource: "workspace",
      agentId: "main",
      ts: nowMs + 1,
    });
    await runSkillCuratorSweep({ env: process.env, nowMs: nowMs + 2 });

    const byKey = new Map(
      getSkillCuratorStatus({ env: process.env }).skills.map((skill) => [skill.skillKey, skill]),
    );
    expect(byKey.get("dormant")?.state).toBe("active");
    expect(byKey.get("deep-archive")?.state).toBe("archived");
    expect(
      restoreCuratedSkill("deep-archive", { env: process.env, nowMs: nowMs + 3 }),
    ).toMatchObject({
      state: "active",
    });
    expect(
      restoreCuratedSkill("unused-archive", { env: process.env, nowMs: nowMs + 3 }),
    ).toMatchObject({ state: "active" });
    await runSkillCuratorSweep({ env: process.env, nowMs: nowMs + 4 });
    expect(
      getSkillCuratorStatus({ env: process.env }).skills.find(
        (skill) => skill.skillKey === "deep-archive",
      )?.state,
    ).toBe("active");
    expect(
      getSkillCuratorStatus({ env: process.env }).skills.find(
        (skill) => skill.skillKey === "unused-archive",
      )?.state,
    ).toBe("archived");
  });

  it("curates same-named skills in separate workspaces independently", async () => {
    const nowMs = ARCHIVE_AFTER_MS + 1;
    const firstSkillFile = path.join(rootDir, "agent-a", "skills", "shared-name", "SKILL.md");
    const secondSkillFile = path.join(rootDir, "agent-b", "skills", "shared-name", "SKILL.md");
    addAppliedSkill({
      name: "Shared Name",
      appliedAtMs: 0,
      proposalId: "shared-name-a",
      agentDirName: "agent-a",
    });
    addAppliedSkill({
      name: "Shared Name",
      appliedAtMs: 0,
      proposalId: "shared-name-b",
      agentDirName: "agent-b",
    });
    await recordSkillUsage({
      skillFile: firstSkillFile,
      skillName: "Shared Name",
      skillSource: "workspace",
      agentId: "agent-a",
      ts: nowMs,
    });

    await runSkillCuratorSweep({ env: process.env, nowMs });
    const status = getSkillCuratorStatus({ env: process.env });
    expect(status.lastError).toBeNull();
    expect(status.overlaps).toEqual([]);
    expect(status.skills).toMatchObject([
      {
        skillFile: firstSkillFile,
        skillKey: "shared-name",
        state: "active",
        useCount: 1,
      },
      {
        skillFile: secondSkillFile,
        skillKey: "shared-name",
        state: "archived",
        useCount: 0,
      },
    ]);

    expect(pinCuratedSkill("shared-name", { env: process.env }).skillFile).toBe(
      status.skills[0]?.skillFile,
    );
    expect(getSkillCuratorStatus({ env: process.env }).skills.every((skill) => skill.pinned)).toBe(
      true,
    );
    unpinCuratedSkill("shared-name", { env: process.env });
    expect(
      restoreCuratedSkill("shared-name", {
        env: process.env,
        nowMs: nowMs + 1,
      }).skillFile,
    ).toBe(secondSkillFile);
    expect(
      getSkillCuratorStatus({ env: process.env }).skills.every((skill) => skill.state === "active"),
    ).toBe(true);
  });

  it("matches applied updates by canonical skill file", async () => {
    addAppliedSkill({ name: "Moved Skill", appliedAtMs: 0 });
    addAppliedSkill({
      name: "Moved Skill",
      appliedAtMs: ARCHIVE_AFTER_MS,
      kind: "update",
      agentDirName: "other-agent",
    });

    await runSkillCuratorSweep({ env: process.env, nowMs: ARCHIVE_AFTER_MS + 1 });
    expect(getSkillCuratorStatus({ env: process.env }).skills).toMatchObject([
      { skillKey: "moved-skill", state: "archived" },
    ]);
  });

  it("prunes lifecycle and usage rows when curated skill files disappear", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    const skillFile = path.join(rootDir, "agent", "skills", "removed-skill", "SKILL.md");
    addAppliedSkill({ name: "Removed Skill", appliedAtMs: nowMs });
    await recordSkillUsage({
      skillFile,
      skillName: "Removed Skill",
      skillSource: "workspace",
      agentId: "main",
      ts: nowMs,
    });
    await runSkillCuratorSweep({ env: process.env, nowMs });
    expect(getSkillCuratorStatus({ env: process.env }).skills).toMatchObject([{ useCount: 1 }]);
    expect(readSkillUsageFiles()).toEqual([skillFile]);

    fs.rmSync(skillFile);
    await runSkillCuratorSweep({ env: process.env, nowMs: nowMs + 1 });

    expect(getSkillCuratorStatus({ env: process.env }).skills).toEqual([]);
    expect(readSkillUsageFiles()).toEqual([]);
  });

  it("leaves manually authored skills outside lifecycle state", async () => {
    addAppliedSkill({ name: "CLI Created", appliedAtMs: 0, createdBy: "cli" });
    await runSkillCuratorSweep({ env: process.env, nowMs: ARCHIVE_AFTER_MS + 1 });
    expect(getSkillCuratorStatus({ env: process.env }).skills).toEqual([]);
  });

  it("uses the latest applied update as lifecycle activity", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    addAppliedSkill({ name: "Updated Skill", appliedAtMs: nowMs - ARCHIVE_AFTER_MS - 1 });
    addAppliedSkill({
      name: "Updated Skill",
      appliedAtMs: nowMs - 1,
      kind: "update",
    });

    await runSkillCuratorSweep({ env: process.env, nowMs });

    expect(getSkillCuratorStatus({ env: process.env }).skills).toMatchObject([
      { skillKey: "updated-skill", state: "active" },
    ]);
  });

  it("records success, overlap candidates, failures, and stale doctor state", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    addAppliedSkill({
      name: "Inbox Morning",
      description: "triage inbox messages every morning",
      appliedAtMs: nowMs,
    });
    addAppliedSkill({
      name: "Inbox Daily",
      description: "triage inbox messages every day",
      appliedAtMs: nowMs,
    });
    addAppliedSkill({
      name: "Inbox Evening",
      description: "triage inbox messages every evening",
      appliedAtMs: nowMs,
      agentDirName: "other-agent",
    });
    await runSkillCuratorSweep({ env: process.env, nowMs });
    expect(getSkillCuratorStatus({ env: process.env })).toMatchObject({
      lastSuccessAtMs: nowMs,
      lastError: null,
      overlaps: [{ left: "inbox-daily", right: "inbox-morning" }],
    });

    store.readManifest.mockRejectedValueOnce(new Error("proposal store unavailable"));
    await expect(
      runSkillCuratorSweep({ env: process.env, nowMs: nowMs + DOCTOR_WEDGED_AFTER_MS + 1 }),
    ).rejects.toThrow("proposal store unavailable");
    expect(getSkillCuratorStatus({ env: process.env }).lastError).toContain(
      "proposal store unavailable",
    );
    expect(
      getSkillCuratorDoctorWarning({
        env: process.env,
        nowMs: nowMs + DOCTOR_WEDGED_AFTER_MS + 1,
      }),
    ).toContain("skill curator has not completed a sweep");
  });

  it("warns when the first sweep attempt remains incomplete for seven days", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    let resolveManifest: ((manifest: SkillProposalManifest) => void) | undefined;
    store.readManifest.mockImplementationOnce(
      () =>
        new Promise<SkillProposalManifest>((resolve) => {
          resolveManifest = resolve;
        }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(nowMs - CURATOR_INITIAL_DELAY_MS);
    let failure: unknown;
    const cleanup = startSkillCuratorMaintenance({
      onError: (error) => {
        failure = error;
      },
      registerUsageTracking: () => () => undefined,
    });
    try {
      vi.advanceTimersByTime(CURATOR_INITIAL_DELAY_MS);
      await Promise.resolve();
      expect(
        getSkillCuratorDoctorWarning({
          env: process.env,
          nowMs: nowMs + DOCTOR_WEDGED_AFTER_MS + 1,
        }),
      ).toContain("skill curator has not completed a sweep");

      resolveManifest?.({
        schema: "openclaw.skill-workshop.proposals-manifest.v1",
        updatedAt: new Date(nowMs).toISOString(),
        proposals: [],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(failure).toBeUndefined();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("filters archived skills from snapshots while retaining stale skills", async () => {
    const nowMs = Date.UTC(2026, 0, 1);
    addAppliedSkill({ name: "Archived Skill", appliedAtMs: nowMs - ARCHIVE_AFTER_MS - 1 });
    addAppliedSkill({ name: "Stale Skill", appliedAtMs: nowMs - STALE_AFTER_MS - 1 });
    await runSkillCuratorSweep({ env: process.env, nowMs });

    const agentDir = path.join(rootDir, "agent");
    const manualAgentDir = path.join(rootDir, "manual-agent");
    writeSkill(agentDir, "archived-skill", "Archived Skill");
    writeSkill(agentDir, "stale-skill", "Stale Skill");
    writeSkill(manualAgentDir, "archived-skill", "Archived Skill");
    const snapshot = loadSkills({
      cwd: rootDir,
      agentDir,
      skillPaths: [path.join(agentDir, "skills"), path.join(manualAgentDir, "skills")],
      includeDefaults: false,
    });

    expect(snapshot.skills.map((skill) => skill.name).toSorted()).toEqual([
      "Archived Skill",
      "Stale Skill",
    ]);
    const workspaceSnapshot = buildWorkspaceSkillSnapshot(agentDir, {
      managedSkillsDir: path.join(rootDir, "managed"),
      bundledSkillsDir: path.join(rootDir, "bundled"),
    });
    const workspaceSkillNames = workspaceSnapshot.skills.map((skill) => skill.name);
    expect(workspaceSkillNames).toContain("Stale Skill");
    expect(workspaceSkillNames).not.toContain("Archived Skill");
    const commandSkillNames = loadVisibleWorkspaceSkillEntries(agentDir, {
      managedSkillsDir: path.join(rootDir, "managed"),
      bundledSkillsDir: path.join(rootDir, "bundled"),
    }).map((entry) => entry.skill.name);
    expect(commandSkillNames).toContain("Stale Skill");
    expect(commandSkillNames).not.toContain("Archived Skill");
  });
});
