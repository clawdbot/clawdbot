import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import {
  buildConversationToolPolicyPipelineSteps,
  resolveConversationToolPolicies,
} from "../agents/conversation-tool-policy-pipeline.js";
import { applyToolPolicyPipeline } from "../agents/tool-policy-pipeline.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { persistClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

describe("Claw tool policy consent provenance", () => {
  it("does not create writable state for an ordinary named profile", () => {
    const root = tempDirs.make("openclaw-non-claw-tool-consent-");
    vi.stubEnv("OPENCLAW_STATE_DIR", join(root, "state"));

    expect(() =>
      resolveConversationCapabilityProfile({
        agentId: "worker",
        config: { agents: { list: [{ id: "worker", tools: { profile: "coding" } }] } },
      }),
    ).not.toThrow();
    expect(existsSync(join(root, "state"))).toBe(false);
  });

  it("fails closed without mutating unreadable consent provenance", () => {
    const root = tempDirs.make("openclaw-unreadable-claw-tool-consent-");
    const stateDir = join(root, "state");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    mkdirSync(dirname(databasePath), { recursive: true });
    writeFileSync(databasePath, "not a sqlite database");
    const before = readFileSync(databasePath);
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);

    expect(() =>
      resolveConversationCapabilityProfile({
        agentId: "worker",
        config: {
          agents: {
            list: [{ id: "worker", tools: { profile: "full", allow: ["read"] } }],
          },
        },
      }),
    ).toThrow("Cannot verify the installed tool authority");
    expect(readFileSync(databasePath)).toEqual(before);
  });

  it("fails closed after a host upgrade leaves legacy profile provenance", async () => {
    const root = tempDirs.make("openclaw-claw-tool-consent-");
    const env = stateEnv(root);
    vi.stubEnv("OPENCLAW_STATE_DIR", join(root, "state"));
    const { plan } = await makeProvenancePlan(
      root,
      { schemaVersion: 1, agent: { id: "worker" } },
      {
        openClawProfile: {
          schemaVersion: 1,
          agent: { tools: { profile: "coding" } },
        },
      },
    );
    persistClawInstallRecord(plan, { env });

    const capabilityProfile = resolveConversationCapabilityProfile({
      agentId: "worker",
      config: { agents: { list: [plan.agent.config] } },
    });
    const policies = resolveConversationToolPolicies({ capabilityProfile });
    const filtered = applyToolPolicyPipeline({
      tools: [{ name: "read" }, { name: "future_tool" }],
      toolMeta: (tool) => (tool.name === "future_tool" ? { pluginId: "read" } : undefined),
      warn: () => {},
      steps: buildConversationToolPolicyPipelineSteps({
        capabilityProfile,
        policies,
        includeRuntimeToolPolicy: true,
      }),
    });
    expect(filtered.map((tool) => tool.name)).toEqual(["read"]);

    openOpenClawStateDatabase({ env })
      .db /* sqlite-allow-raw: test-only downgrade simulates an install created by the previous host. */
      .prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
      .run("openclaw.clawInstallRecord.v1", "worker");

    expect(() =>
      resolveConversationCapabilityProfile({
        agentId: "worker",
        config: {
          agents: {
            list: [
              {
                ...plan.agent.config,
                tools: { profile: "coding" },
              },
            ],
          },
        },
      }),
    ).toThrow("uses a legacy dynamic tool policy");
  });
});
