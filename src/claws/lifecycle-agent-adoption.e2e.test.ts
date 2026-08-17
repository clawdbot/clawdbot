import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";

const execFileAsync = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function runBuiltOpenClaw(args: string[], stateDir: string) {
  const result = await execFileAsync(process.execPath, ["openclaw.mjs", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: stateDir,
      USERPROFILE: stateDir,
      OPENCLAW_CONFIG_PATH: join(stateDir, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_EXPERIMENTAL_CLAWS: "1",
      OPENCLAW_HOME: stateDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
      VITEST: "",
    },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe("configured agent adoption built CLI e2e", () => {
  it("manages declared state while retaining the pre-Claws history on remove", async () => {
    const stateDir = tempDirs.make("openclaw-claws-agent-adopt-e2e-");
    const workspace = join(stateDir, "existing-workspace");
    await mkdir(join(workspace, "reference"), { recursive: true });
    for (const path of ["SOUL.md", "HEARTBEAT.md", "reference/policy.md"]) {
      await copyFile(join("src/claws/fixtures/workspace", path), join(workspace, path));
    }
    const canonicalWorkspace = await realpath(workspace);
    const agentDir = join(stateDir, "agents", "workspace-agent");
    const agentDatabase = resolveOpenClawAgentSqlitePath({
      agentId: "workspace-agent",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const sessionStorePath = join(agentDir, "sessions", "sessions.json");
    const sessionKey = "agent:workspace-agent:pre-claws";
    const sessionId = "pre-claws-session";
    const stateSentinel = join(agentDir, "pre-claws-state.txt");
    const transcriptSentinel = join(agentDir, "sessions", "pre-claws-transcript.jsonl");
    const undeclared = join(workspace, "operator-notes.md");
    await mkdir(join(agentDir, "sessions"), { recursive: true });
    await upsertSessionEntryCore(
      { agentId: "workspace-agent", sessionKey, storePath: sessionStorePath },
      { sessionId, updatedAt: 1 },
    );
    const transcriptEvent = {
      id: "pre-claws-event",
      marker: "pre-claws-history",
      timestamp: "1970-01-01T00:00:00.001Z",
      type: "metadata",
    };
    await appendTranscriptEvent(
      { agentId: "workspace-agent", sessionId, sessionKey, storePath: sessionStorePath },
      transcriptEvent,
    );
    await writeFile(stateSentinel, "pre-claws-agent-state\n", "utf8");
    await writeFile(transcriptSentinel, "pre-claws-transcript-sentinel\n", "utf8");
    await writeFile(undeclared, "operator-owned\n", "utf8");
    await writeFile(
      join(stateDir, "openclaw.json"),
      `${JSON.stringify(
        {
          agents: {
            entries: {
              main: {},
              "workspace-agent": {
                default: true,
                name: "Workspace Agent",
                identity: { name: "Workspace" },
                workspace: canonicalWorkspace,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    expect(
      loadSessionEntry({ agentId: "workspace-agent", sessionKey, storePath: sessionStorePath }),
    ).toMatchObject({ sessionId });
    await expect(
      loadTranscriptEvents({
        agentId: "workspace-agent",
        sessionId,
        sessionKey,
        storePath: sessionStorePath,
      }),
    ).resolves.toContainEqual(transcriptEvent);
    closeOpenClawAgentDatabasesForTest();

    const source = "src/claws/fixtures/workspace-agent.claw.json";
    const preview = await runBuiltOpenClaw(
      [
        "claws",
        "add",
        source,
        "--workspace",
        workspace,
        "--adopt-existing-agent",
        "--dry-run",
        "--json",
      ],
      stateDir,
    );
    expect(preview).toMatchObject({
      blockers: [],
      actions: expect.arrayContaining([
        expect.objectContaining({ kind: "agent", action: "adopt" }),
        expect.objectContaining({ kind: "workspace", action: "adopt" }),
      ]),
    });
    const added = await runBuiltOpenClaw(
      [
        "claws",
        "add",
        source,
        "--workspace",
        workspace,
        "--adopt-existing-agent",
        "--yes",
        "--plan-integrity",
        String(preview.planIntegrity),
        "--json",
      ],
      stateDir,
    );
    expect(added).toMatchObject({
      status: "complete",
      agent: { finalId: "workspace-agent" },
      installRecord: {
        agentOrigin: "adopted",
        schemaVersion: "openclaw.clawInstallRecord.v3",
      },
    });
    const adoptedConfig = {
      default: true,
      name: "Workspace Agent",
      identity: { name: "Workspace" },
      workspace: canonicalWorkspace,
    };
    expect(
      JSON.parse(await readFile(join(stateDir, "openclaw.json"), "utf8")).agents.entries[
        "workspace-agent"
      ],
    ).toEqual(adoptedConfig);

    const status = await runBuiltOpenClaw(
      ["claws", "status", "workspace-agent", "--json"],
      stateDir,
    );
    expect(status).toMatchObject({
      records: [
        {
          agentOrigin: "adopted",
          agentState: "present",
          install: { agentId: "workspace-agent", agentOrigin: "adopted" },
        },
      ],
    });

    const updatePlan = await runBuiltOpenClaw(
      ["claws", "update", "workspace-agent", "--dry-run", "--json"],
      stateDir,
    );
    const updated = await runBuiltOpenClaw(
      [
        "claws",
        "update",
        "workspace-agent",
        "--yes",
        "--plan-integrity",
        String(updatePlan.planIntegrity),
        "--json",
      ],
      stateDir,
    );
    expect(updated).toMatchObject({
      status: "complete",
      installRecord: { agentOrigin: "adopted" },
    });
    expect(
      JSON.parse(await readFile(join(stateDir, "openclaw.json"), "utf8")).agents.entries[
        "workspace-agent"
      ],
    ).toEqual(adoptedConfig);

    const removePlan = await runBuiltOpenClaw(
      ["claws", "remove", "workspace-agent", "--dry-run", "--json"],
      stateDir,
    );
    expect(removePlan).toMatchObject({
      blockers: [],
      actions: expect.arrayContaining([
        expect.objectContaining({ kind: "agentState", action: "retain" }),
        expect.objectContaining({ kind: "sessionIndex", action: "retain" }),
        expect.objectContaining({ kind: "sessionTranscripts", action: "retain" }),
      ]),
    });
    const removed = await runBuiltOpenClaw(
      [
        "claws",
        "remove",
        "workspace-agent",
        "--yes",
        "--plan-integrity",
        String(removePlan.planIntegrity),
        "--json",
      ],
      stateDir,
    );
    expect(removed).toMatchObject({ status: "complete", agentRemoved: true });

    const config = JSON.parse(await readFile(join(stateDir, "openclaw.json"), "utf8"));
    expect(config.agents.entries["workspace-agent"]).toBeUndefined();
    await expect(access(join(workspace, "SOUL.md"))).rejects.toThrow();
    await expect(access(agentDatabase)).resolves.toBeUndefined();
    expect(
      loadSessionEntry({ agentId: "workspace-agent", sessionKey, storePath: sessionStorePath }),
    ).toMatchObject({ sessionId });
    await expect(
      loadTranscriptEvents({
        agentId: "workspace-agent",
        sessionId,
        sessionKey,
        storePath: sessionStorePath,
      }),
    ).resolves.toContainEqual(transcriptEvent);
    await expect(readFile(stateSentinel, "utf8")).resolves.toBe("pre-claws-agent-state\n");
    await expect(readFile(transcriptSentinel, "utf8")).resolves.toBe(
      "pre-claws-transcript-sentinel\n",
    );
    await expect(readFile(undeclared, "utf8")).resolves.toBe("operator-owned\n");
    closeOpenClawAgentDatabasesForTest();
  });
});
