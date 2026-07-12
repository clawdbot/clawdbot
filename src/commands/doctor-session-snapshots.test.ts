// Doctor session snapshot tests cover session snapshot validation and repair guidance.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionStoreCacheForTest,
  saveSessionStore,
  updateSessionStore,
} from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { __testing as openClawRootTesting } from "../infra/openclaw-root.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import type { Skill } from "../skills/loading/skill-contract.js";

const note = vi.hoisted(() => vi.fn());
const atomicWriteControl = vi.hoisted(() => ({
  beforeWrite: undefined as undefined | ((filePath: string) => Promise<void>),
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));
vi.mock("../infra/json-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/json-files.js")>();
  return {
    ...actual,
    writeTextAtomic: async (...args: Parameters<typeof actual.writeTextAtomic>) => {
      await atomicWriteControl.beforeWrite?.(args[0]);
      return await actual.writeTextAtomic(...args);
    },
  };
});

import {
  detectSessionSnapshotHealthIssues,
  noteSessionSnapshotHealth,
  resolveSessionSnapshotBundledSkillsDir,
  scanSessionStoreForStaleRuntimeSnapshotPaths,
  sessionSnapshotIssueToHealthFinding,
  sessionSnapshotIssueToRepairEffect,
} from "./doctor-session-snapshots.js";

function sessionEntry(patch: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: Date.now(),
    ...patch,
  };
}

function skillPrompt(location: string): string {
  return [
    "<available_skills>",
    "  <skill>",
    "    <name>doctor</name>",
    "    <description>Doctor skill</description>",
    `    <location>${location}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");
}

function resolvedSkill(skillPath: string): Skill {
  const baseDir = path.dirname(skillPath);
  return {
    name: "doctor",
    description: "Doctor skill",
    filePath: skillPath,
    baseDir,
    source: "bundled",
    sourceInfo: {
      path: skillPath,
      source: "bundled",
      scope: "user",
      origin: "top-level",
      baseDir,
    },
    disableModelInvocation: false,
  };
}

async function writeSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

function readMainSessionEntry(raw: string): SessionEntry {
  const parsed = JSON.parse(raw) as Record<string, SessionEntry>;
  const entry = parsed["agent:main"];
  if (!entry) {
    throw new Error("expected agent:main session entry");
  }
  return entry;
}

function readMainSkillsSnapshot(raw: string): NonNullable<SessionEntry["skillsSnapshot"]> {
  const snapshot = readMainSessionEntry(raw).skillsSnapshot;
  if (!snapshot) {
    throw new Error("expected agent:main skills snapshot");
  }
  return snapshot;
}

afterEach(() => {
  atomicWriteControl.beforeWrite = undefined;
  clearSessionStoreCacheForTest();
});

describe("doctor session snapshot stale runtime metadata", () => {
  let root = "";
  let bundledSkillsDir = "";

  beforeEach(async () => {
    note.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-session-snapshots-"));
    bundledSkillsDir = path.join(root, "current", "skills");
    await fs.mkdir(path.join(bundledSkillsDir, "doctor"), { recursive: true });
    await fs.writeFile(path.join(bundledSkillsDir, "doctor", "SKILL.md"), "# Doctor\n");
  });

  afterEach(async () => {
    openClawRootTesting.clearOpenClawPackageRootCaches();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("flags cached bundled skill locations from inactive and temp-backed runtime roots", () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const tempBackedPath = path.join(
      path.sep,
      "private",
      "tmp",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      store: {
        "agent:main": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(stalePath),
            skills: [{ name: "doctor" }],
          },
        }),
        "agent:temp": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(tempBackedPath),
            skills: [{ name: "doctor" }],
          },
        }),
      },
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:main",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
      },
      {
        sessionKey: "agent:temp",
        field: "skillsSnapshot.prompt",
        cachedPath: tempBackedPath,
        expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
      },
    ]);
  });

  it("maps stale snapshot paths to structured findings and dry-run effects", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    const [issue] = await detectSessionSnapshotHealthIssues({
      storePaths: [storePath],
      bundledSkillsDir,
    });

    if (!issue) {
      throw new Error("expected session snapshot health issue");
    }
    expect(issue).toMatchObject({
      storePath,
      sessionKey: "agent:main",
      field: "skillsSnapshot.prompt",
      cachedPath: stalePath,
      expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
    });
    expect(sessionSnapshotIssueToHealthFinding(issue)).toMatchObject({
      checkId: "core/doctor/session-snapshots",
      severity: "info",
      path: storePath,
      target: stalePath,
      requirement: expect.stringContaining(bundledSkillsDir),
      fixHint: expect.stringContaining("openclaw doctor --fix"),
    });
    expect(sessionSnapshotIssueToRepairEffect(issue)).toEqual({
      kind: "file",
      action: "would-rewrite-session-snapshot-path",
      target: storePath,
      dryRunSafe: false,
    });
  });

  it("expands home-relative cached bundled skill locations before classifying them", () => {
    const homeDir = path.join(root, "home");
    const stalePath = "~/old-runtime/node_modules/openclaw/skills/doctor/SKILL.md";

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      env: { HOME: homeDir },
      store: {
        "agent:home": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(stalePath),
            skills: [{ name: "doctor" }],
          },
        }),
      },
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:home",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: path.join(bundledSkillsDir, "doctor", "SKILL.md"),
      },
    ]);
  });

  it("repairs stale imsg bundled paths to the generated plugin skill path", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "imsg",
      "SKILL.md",
    );
    const stateDir = path.join(root, "state");
    const pluginSkillPath = path.join(stateDir, "plugin-skills", "imsg", "SKILL.md");
    await fs.mkdir(path.dirname(pluginSkillPath), { recursive: true });
    await fs.writeFile(pluginSkillPath, "# imsg\n");

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      env: { OPENCLAW_STATE_DIR: stateDir },
      store: {
        "agent:imsg": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(stalePath),
            skills: [{ name: "imsg" }],
          },
        }),
      },
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:imsg",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: pluginSkillPath,
      },
    ]);
  });

  it("repairs retired imsg paths even when cached under the current package skills root", async () => {
    const packageSkillsDir = path.join(root, "node_modules", "openclaw", "skills");
    const stalePath = path.join(packageSkillsDir, "imsg", "SKILL.md");
    const stateDir = path.join(root, "state");
    const pluginSkillPath = path.join(stateDir, "plugin-skills", "imsg", "SKILL.md");
    await fs.mkdir(path.dirname(pluginSkillPath), { recursive: true });
    await fs.writeFile(pluginSkillPath, "# imsg\n");

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir: packageSkillsDir,
      env: { OPENCLAW_STATE_DIR: stateDir },
      store: {
        "agent:imsg": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(stalePath),
            skills: [{ name: "imsg" }],
          },
        }),
      },
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:imsg",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: pluginSkillPath,
      },
    ]);
  });

  it("resolves the retired package skills root for moved-skill snapshot repairs", async () => {
    const packageRoot = path.join(root, "package");
    const distDir = path.join(packageRoot, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw" }),
    );
    const modulePath = path.join(distDir, "doctor-session-snapshots.js");
    await fs.writeFile(modulePath, "// stub\n");

    expect(
      resolveSessionSnapshotBundledSkillsDir({
        moduleUrl: pathToFileURL(modulePath).href,
        argv1: path.join(packageRoot, "bin", "openclaw"),
        cwd: distDir,
      }),
    ).toBe(path.join(packageRoot, "skills"));
  });

  it("ignores current bundled locations and unrelated workspace skill locations", () => {
    const currentPath = path.join(bundledSkillsDir, "doctor", "SKILL.md");
    const workspacePath = path.join(root, "workspace", "skills", "doctor", "SKILL.md");
    const openClawWorkspacePath = path.join(
      root,
      "projects",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir,
      store: {
        "agent:current": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(currentPath), skills: [{ name: "doctor" }] },
        }),
        "agent:workspace": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(workspacePath), skills: [{ name: "doctor" }] },
        }),
        "agent:openclaw-workspace": sessionEntry({
          skillsSnapshot: {
            prompt: skillPrompt(openClawWorkspacePath),
            skills: [{ name: "doctor" }],
          },
        }),
      },
      pathExists: (filePath) => filePath === currentPath,
    });

    expect(findings).toEqual([]);
  });

  it("handles Windows current and stale bundled skill paths without false positives", () => {
    const windowsBundledSkillsDir = path.win32.join(
      "C:\\",
      "Users",
      "alice",
      ".openclaw",
      "lib",
      "node_modules",
      "openclaw",
      "skills",
    );
    const currentPath = path.win32.join(windowsBundledSkillsDir, "doctor", "SKILL.md");
    const stalePath = path.win32.join(
      "C:\\",
      "opt",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );

    const findings = scanSessionStoreForStaleRuntimeSnapshotPaths({
      bundledSkillsDir: windowsBundledSkillsDir,
      store: {
        "agent:current": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(currentPath), skills: [{ name: "doctor" }] },
        }),
        "agent:stale": sessionEntry({
          skillsSnapshot: { prompt: skillPrompt(stalePath), skills: [{ name: "doctor" }] },
        }),
      },
      pathExists: (filePath) => filePath === currentPath,
    });

    expect(findings).toEqual([
      {
        sessionKey: "agent:stale",
        field: "skillsSnapshot.prompt",
        cachedPath: stalePath,
        expectedPath: currentPath,
      },
    ]);
  });

  it("reports stale cached metadata while distinguishing the live runtime root", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({ storePaths: [storePath], bundledSkillsDir });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session snapshots");
    expect(message).toContain("stale cached session metadata paths");
    expect(message).toContain("Live bundled skills root is healthy");
    expect(message).toContain("inactive runtime root");
    expect(message).toContain(stalePath);
    expect(message).toContain(path.join(bundledSkillsDir, "doctor", "SKILL.md"));
  });

  it("scans resolvedSkills before session store normalization strips them", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "doctor" }],
          resolvedSkills: [resolvedSkill(stalePath)],
        },
      }),
    });

    await noteSessionSnapshotHealth({ storePaths: [storePath], bundledSkillsDir });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("agent:main");
    expect(message).toContain("skillsSnapshot.resolvedSkills");
    expect(message).toContain(stalePath);
  });

  it("hydrates blobbed skills prompts before scanning raw session stores", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    const prompt = `${skillPrompt(stalePath)}\n${"padding\n".repeat(200)}`;
    await saveSessionStore(
      storePath,
      {
        "agent:main": sessionEntry({
          skillsSnapshot: {
            prompt,
            skills: [{ name: "doctor" }],
          },
        }),
      },
      { skipMaintenance: true },
    );
    const raw = await fs.readFile(storePath, "utf-8");
    expect(raw).not.toContain(stalePath);
    expect(raw).toContain("promptRef");

    await noteSessionSnapshotHealth({ storePaths: [storePath], bundledSkillsDir });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("agent:main");
    expect(message).toContain("skillsSnapshot.prompt");
    expect(message).toContain(stalePath);
  });

  it("reports stale cached metadata from configured session stores", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const stateDir = path.join(root, "state");
    const defaultStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await writeSessionStore(defaultStorePath, {});
    await writeSessionStore(configuredStorePath, {
      "agent:configured": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      cfg: { session: { store: configuredStorePath } } as OpenClawConfig,
      bundledSkillsDir,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain(configuredStorePath);
    expect(message).toContain("agent:configured");
    expect(message).toContain(stalePath);
  });

  it("reports stale cached metadata from templated configured session stores", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const templatedStore = path.join(root, "stores", "{agentId}", "sessions.json");
    const opsStorePath = path.join(root, "stores", "ops", "sessions.json");
    await writeSessionStore(opsStorePath, {
      "agent:ops": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      cfg: {
        session: { store: templatedStore },
        agents: { list: [{ id: "main" }, { id: "ops" }] },
      } as OpenClawConfig,
      bundledSkillsDir,
      env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain(opsStorePath);
    expect(message).toContain("agent:ops");
    expect(message).toContain(stalePath);
  });
});

describe("doctor session snapshot repair (shouldRepair)", () => {
  let root = "";
  let bundledSkillsDir = "";

  beforeEach(async () => {
    note.mockClear();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-repair-"));
    bundledSkillsDir = path.join(root, "current", "skills");
    await fs.mkdir(path.join(bundledSkillsDir, "doctor"), { recursive: true });
    await fs.writeFile(path.join(bundledSkillsDir, "doctor", "SKILL.md"), "# Doctor\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("repairs stale inline prompt paths", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    const raw = await fs.readFile(storePath, "utf-8");
    const snapshot = readMainSkillsSnapshot(raw);
    expect(snapshot.prompt).not.toContain(stalePath);
    expect(snapshot.prompt).toContain(path.join(bundledSkillsDir, "doctor", "SKILL.md"));
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("Repaired");
  });

  it("preserves a supervised session added while the repair backup is pending", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    let markBackupStarted!: () => void;
    const backupStarted = new Promise<void>((resolve) => {
      markBackupStarted = resolve;
    });
    let releaseBackup!: () => void;
    const backupReleased = new Promise<void>((resolve) => {
      releaseBackup = resolve;
    });
    let blockedBackup = false;
    atomicWriteControl.beforeWrite = async (filePath) => {
      if (blockedBackup || !filePath.startsWith(`${storePath}.bak.`)) {
        return;
      }
      blockedBackup = true;
      markBackupStarted();
      await backupReleased;
    };

    const repair = noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });
    await backupStarted;

    const supervisedKey = "agent:main:harness:codex:supervision:concurrent";
    const concurrentWrite = updateSessionStore(
      storePath,
      (store) => {
        store[supervisedKey] = sessionEntry({
          sessionId: "supervised-session",
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        });
      },
      { requireWriteSuccess: true, skipMaintenance: true },
    );
    releaseBackup();
    await Promise.all([repair, concurrentWrite]);

    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, SessionEntry>;
    expect(parsed[supervisedKey]).toMatchObject({
      sessionId: "supervised-session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
    expect(readMainSkillsSnapshot(raw).prompt).not.toContain(stalePath);
  });

  it("rejects repair when the current store contains an invalid reserved session", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    const invalidKey = "agent:main:harness:codex:supervision:invalid";
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
      [invalidKey]: sessionEntry({
        sessionId: "invalid-supervised-session",
        agentHarnessId: "other",
        modelSelectionLocked: true,
      }),
    });
    const rawBefore = await fs.readFile(storePath, "utf-8");

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    expect(await fs.readFile(storePath, "utf-8")).toBe(rawBefore);
    expect(note.mock.calls.some(([message]) => String(message).includes("Failed to repair"))).toBe(
      true,
    );
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE),
      ),
    ).toBe(true);
    expect(note.mock.calls.some(([message]) => String(message).includes("Repaired"))).toBe(false);
  });

  it("repairs stale promptRef blob paths", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    const prompt = `${skillPrompt(stalePath)}\n${"padding\n".repeat(200)}`;
    await saveSessionStore(
      storePath,
      {
        "agent:main": sessionEntry({
          skillsSnapshot: {
            prompt,
            skills: [{ name: "doctor" }],
          },
        }),
      },
      { skipMaintenance: true },
    );

    const rawBefore = await fs.readFile(storePath, "utf-8");
    expect(rawBefore).toContain("promptRef");
    expect(rawBefore).not.toContain(stalePath);

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    const rawAfter = await fs.readFile(storePath, "utf-8");
    expect(rawAfter).toContain("promptRef");
    expect(rawAfter).not.toContain(stalePath);
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("Repaired");
  });

  it("drops stale legacy resolvedSkills cache entries", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "doctor" }],
          resolvedSkills: [resolvedSkill(stalePath)],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    const raw = await fs.readFile(storePath, "utf-8");
    const snapshot = readMainSkillsSnapshot(raw);
    expect(snapshot.resolvedSkills).toBeUndefined();
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("Repaired");
  });

  it("drops resolvedSkills cache entries with stale sourceInfo paths", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const currentPath = path.join(bundledSkillsDir, "doctor", "SKILL.md");
    const skill = resolvedSkill(currentPath);
    skill.sourceInfo.path = stalePath;
    skill.sourceInfo.baseDir = path.dirname(stalePath);

    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: "",
          skills: [{ name: "doctor" }],
          resolvedSkills: [skill],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    const raw = await fs.readFile(storePath, "utf-8");
    const snapshot = readMainSkillsSnapshot(raw);
    expect(snapshot.resolvedSkills).toBeUndefined();
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("Repaired");
  });

  it("preserves sessions with missing promptRef blobs", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:healthy": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
      "agent:missing-blob": sessionEntry({
        skillsSnapshot: {
          prompt: "",
          promptRef: { version: 1, algorithm: "sha256", hash: "a".repeat(64), bytes: 100 },
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["agent:missing-blob"].skillsSnapshot).toBeDefined();
    expect(parsed["agent:missing-blob"].skillsSnapshot.promptRef).toBeDefined();
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("Repaired");
  });

  it("handles missing blob gracefully without crashing or reporting false findings", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    const prompt = `${skillPrompt(stalePath)}\n${"padding\n".repeat(200)}`;
    await saveSessionStore(
      storePath,
      {
        "agent:main": sessionEntry({
          skillsSnapshot: {
            prompt,
            skills: [{ name: "doctor" }],
          },
        }),
      },
      { skipMaintenance: true },
    );

    const rawBefore = await fs.readFile(storePath, "utf-8");
    expect(rawBefore).toContain("promptRef");

    // Delete the blob file — simulates corrupted/missing blob state
    const blobDir = path.join(path.dirname(storePath), "skills-prompts");
    await fs.rm(blobDir, { recursive: true, force: true });

    // Scanner hydration strips skillsSnapshot for missing blob,
    // so no findings are reported. Repair should noop gracefully.
    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    expect(note).not.toHaveBeenCalled();

    // Verify the store is still valid JSON and the session entry is preserved
    const rawAfter = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(rawAfter);
    expect(parsed["agent:main"]).toBeDefined();
  });

  it("scoped replacement preserves unrelated content", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    const entry = {
      ...sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
      transcript: `User mentioned ${stalePath} in their message.`,
    } satisfies SessionEntry & { transcript: string };
    await writeSessionStore(storePath, {
      "agent:main": entry,
    });

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["agent:main"].transcript).toContain(stalePath);
    expect(parsed["agent:main"].skillsSnapshot.prompt).not.toContain(stalePath);
    expect(parsed["agent:main"].skillsSnapshot.prompt).toContain(bundledSkillsDir);
  });

  it("creates backup before repair", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });

    const dir = path.dirname(storePath);
    const files = await fs.readdir(dir);
    const backupFiles = files.filter((f) => f.startsWith("sessions.json.bak."));
    expect(backupFiles.length).toBe(1);

    const backupContent = await fs.readFile(
      path.join(dir, expectDefined(backupFiles[0], "backupFiles[0] test invariant")),
      "utf-8",
    );
    const backupSnapshot = readMainSkillsSnapshot(backupContent);
    expect(backupSnapshot.prompt).toContain(stalePath);
  });

  it("is idempotent — second repair finds nothing", async () => {
    const stalePath = path.join(
      root,
      "old-runtime",
      "node_modules",
      "openclaw",
      "skills",
      "doctor",
      "SKILL.md",
    );
    const storePath = path.join(root, "state", "agents", "main", "sessions", "sessions.json");
    await writeSessionStore(storePath, {
      "agent:main": sessionEntry({
        skillsSnapshot: {
          prompt: skillPrompt(stalePath),
          skills: [{ name: "doctor" }],
        },
      }),
    });

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });
    expect(note).toHaveBeenCalledTimes(1);
    note.mockClear();

    await noteSessionSnapshotHealth({
      storePaths: [storePath],
      bundledSkillsDir,
      shouldRepair: true,
    });
    expect(note).not.toHaveBeenCalled();
  });
});
