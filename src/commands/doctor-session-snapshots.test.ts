import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import {
  noteSessionSnapshotHealth,
  scanSessionStoreForStaleRuntimeSnapshotPaths,
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

async function writeSessionStore(
  storePath: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

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
          resolvedSkills: [
            {
              name: "doctor",
              description: "Doctor skill",
              source: "bundled",
              filePath: stalePath,
              baseDir: path.dirname(stalePath),
              sourceInfo: {
                path: stalePath,
                source: "bundled",
                scope: "user",
                origin: "top-level",
                baseDir: path.dirname(stalePath),
              },
              disableModelInvocation: false,
            },
          ],
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
