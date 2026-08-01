import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyntheticSourceInfo } from "../../agents/sessions/source-info.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import { buildWorkspaceSkillSnapshot, loadWorkspaceSkillEntries } from "../loading/workspace.js";
import type { SkillEntry } from "../types.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import {
  mergeRemoteNodeSkillEntries,
  recordRemoteSkillNodeInfo,
  removeRemoteNodeSkills,
  replaceRemoteNodeSkills,
} from "./remote-skills.js";
import { resetRemoteNodeSkillsForTests } from "./remote-skills.test-support.js";

function content(name: string, description: string, body = "# Instructions"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

function localEntry(name: string): SkillEntry {
  const filePath = `/local/${name}/SKILL.md`;
  return {
    skill: {
      name,
      description: `Local ${name}`,
      filePath,
      baseDir: `/local/${name}`,
      source: "test",
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
      disableModelInvocation: false,
    },
    frontmatter: { name, description: `Local ${name}` },
  };
}

beforeEach(() => {
  resetRemoteNodeSkillsForTests();
});

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

describe("node-hosted skill snapshots", () => {
  it("appears while connected, includes the locator note, and disappears on disconnect", () => {
    const before = getSkillsSnapshotVersion();
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      displayName: "Build Mac",
      commands: ["system.run"],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      displayName: "Build Mac",
      skills: [
        {
          name: "release-helper",
          description: "Prepare a release",
          content: content("release-helper", "Prepare a release"),
        },
      ],
    });

    const entries = loadWorkspaceSkillEntries("/workspace", {
      workspaceOnly: true,
      eligibility: { nodeSkills: { canExec: true } },
    });
    const snapshot = buildWorkspaceSkillSnapshot("/workspace", { entries });
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["release-helper"]);
    expect(snapshot.prompt).toContain("Build Mac (node-1)");
    expect(snapshot.prompt).toContain(
      "Read this SKILL.md with the normal read tool at its exact node:// location",
    );
    expect(snapshot.prompt).toContain("do not use file_fetch");
    expect(snapshot.prompt).toContain("to run cat SKILL.md");
    expect(snapshot.prompt).toContain("exec host=node node=node-1");
    expect(snapshot.prompt).toContain("workdir=node://node-1/skills/release-helper");
    expect(snapshot.prompt).toContain("node host resolves that locator");
    expect(snapshot.prompt).toContain("node://node-1/skills/release-helper/SKILL.md");
    expect(snapshot.resolvedSkills?.[0]?.readContent).toBe(
      content("release-helper", "Prepare a release"),
    );
    expect(getSkillsSnapshotVersion()).toBeGreaterThan(before);

    const connectedVersion = getSkillsSnapshotVersion();
    removeRemoteNodeSkills("node-1");
    expect(mergeRemoteNodeSkillEntries([])).toEqual([]);
    expect(getSkillsSnapshotVersion()).toBeGreaterThan(connectedVersion);
  });

  it("prefixes node skills on local and cross-node collisions", () => {
    recordRemoteSkillNodeInfo({ nodeId: "node-a", connId: "a", commands: ["system.run"] });
    recordRemoteSkillNodeInfo({ nodeId: "node-b", connId: "b", commands: ["system.run"] });
    for (const nodeId of ["node-a", "node-b"]) {
      replaceRemoteNodeSkills({
        nodeId,
        skills: [
          {
            name: "deploy",
            description: "Deploy",
            content: content("deploy", "Deploy"),
          },
          {
            name: "local-only",
            description: "Remote collision",
            content: content("local-only", "Remote collision"),
          },
        ],
      });
    }

    const names = mergeRemoteNodeSkillEntries([localEntry("local-only")], {
      canExec: true,
    }).map((entry) => entry.skill.name);
    expect(names).toEqual([
      "local-only",
      "node-a-deploy",
      "node-a-local-only",
      "node-b-deploy",
      "node-b-local-only",
    ]);
  });

  it("prefixes an original remote name that collides with a generated name", () => {
    recordRemoteSkillNodeInfo({ nodeId: "node-a", connId: "a", commands: ["system.run"] });
    recordRemoteSkillNodeInfo({ nodeId: "node-b", connId: "b", commands: ["system.run"] });
    replaceRemoteNodeSkills({
      nodeId: "node-a",
      skills: [{ name: "deploy", description: "Deploy", content: content("deploy", "Deploy") }],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-b",
      skills: [
        {
          name: "node-a-deploy",
          description: "Another deploy",
          content: content("node-a-deploy", "Another deploy"),
        },
      ],
    });

    expect(
      mergeRemoteNodeSkillEntries([localEntry("deploy")], { canExec: true }).map(
        (entry) => entry.skill.name,
      ),
    ).toEqual(["deploy", "node-a-deploy", "node-b-node-a-deploy"]);
  });

  it("limits node skills to the effective exec node binding", () => {
    for (const [nodeId, displayName] of [
      ["node-a-123456", "Build A"],
      ["node-b-123456", "Build B"],
    ] as const) {
      recordRemoteSkillNodeInfo({
        nodeId,
        displayName,
        connId: nodeId,
        commands: ["system.run"],
      });
      replaceRemoteNodeSkills({
        nodeId,
        displayName,
        skills: [
          {
            name: `${nodeId.slice(0, 6)}-skill`,
            description: `Skill from ${displayName}`,
            content: content(`${nodeId.slice(0, 6)}-skill`, `Skill from ${displayName}`),
          },
        ],
      });
    }

    expect(
      mergeRemoteNodeSkillEntries([], { canExec: true, node: "Build A" }).map(
        (entry) => entry.skill.name,
      ),
    ).toEqual(["node-a-skill"]);
    expect(mergeRemoteNodeSkillEntries([], { canExec: true, node: "missing" })).toEqual([]);
  });

  it("includes connected node skills in workspace status", () => {
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      commands: ["system.run"],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [
        {
          name: "status-skill",
          description: "Visible in status",
          content: content("status-skill", "Visible in status"),
        },
      ],
    });

    const report = buildWorkspaceSkillStatus("/workspace", {
      eligibility: { nodeSkills: { canExec: true } },
    });
    expect(report.skills.map((skill) => skill.name)).toContain("status-skill");
  });

  it("suppresses direct tool dispatch from node skill frontmatter", () => {
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      commands: ["system.run"],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [
        {
          name: "dispatch-skill",
          description: "Must run on its node",
          content:
            "---\nname: dispatch-skill\ndescription: Must run on its node\ncommand-dispatch: tool\ncommand-tool: exec\n---\n",
        },
      ],
    });
    const entries = mergeRemoteNodeSkillEntries([], { canExec: true });

    const [command] = buildWorkspaceSkillCommandSpecs("/workspace", { entries });
    expect(command?.skillName).toBe("dispatch-skill");
    expect(command?.dispatch).toBeUndefined();
  });

  it("accepts JSON5-style metadata from node skills", () => {
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      commands: ["system.run"],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [
        {
          name: "json5-metadata",
          description: "JSON5-style metadata",
          content: `---
name: json5-metadata
description: JSON5-style metadata
metadata:
  {
    "openclaw":
      {
        "requires":
          {
            "env": ["EXAMPLE_VAR"],
          },
      },
  }
---
`,
        },
      ],
    });

    const [entry] = mergeRemoteNodeSkillEntries([], { canExec: true });
    expect(entry?.skill.name).toBe("json5-metadata");
    expect(entry?.frontmatter?.metadata).toContain("EXAMPLE_VAR");
  });

  it("drops content that fails existing frontmatter parsing", () => {
    const warn = captureWarningLogger();
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      commands: ["system.run"],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [
        {
          name: "broken-skill",
          description: "Broken",
          content: "---\nname: [broken\ndescription: Broken\n---\n",
        },
      ],
    });

    expect(mergeRemoteNodeSkillEntries([], { canExec: true })).toEqual([]);
    const warningText = warn.mock.calls.flat().map(String).join("\n");
    expect(warningText).toContain("node://node-1/skills/broken-skill/SKILL.md");
    expect(warningText).toContain("BAD_INDENT");
  });

  it("replaces a node catalog and invalidates the snapshot", () => {
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      commands: ["system.run"],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [{ name: "first", description: "First", content: content("first", "First") }],
    });
    const firstVersion = getSkillsSnapshotVersion();

    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [{ name: "second", description: "Second", content: content("second", "Second") }],
    });

    expect(
      mergeRemoteNodeSkillEntries([], { canExec: true }).map((entry) => entry.skill.name),
    ).toEqual(["second"]);
    expect(getSkillsSnapshotVersion()).toBeGreaterThan(firstVersion);
  });

  it("hides skills when the session or publishing node cannot execute on the node", () => {
    recordRemoteSkillNodeInfo({ nodeId: "node-1", connId: "conn-1", commands: [] });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      skills: [{ name: "remote", description: "Remote", content: content("remote", "Remote") }],
    });

    expect(mergeRemoteNodeSkillEntries([], { canExec: true })).toEqual([]);
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      commands: ["system.run"],
    });
    expect(mergeRemoteNodeSkillEntries([], { canExec: false })).toEqual([]);
    expect(mergeRemoteNodeSkillEntries([], { canExec: true })).toHaveLength(1);
  });
});
