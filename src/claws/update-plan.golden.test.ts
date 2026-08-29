import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { goldenPlanDigest, normalizeGoldenPlan } from "./golden-plan.test-support.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawPackageRef } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawManifest, ClawOpenClawProfile, ClawSourceIdentity } from "./types.js";
import { buildClawUpdatePlan } from "./update-plan.js";
import {
  createUpdatePlanFixture,
  packagePreflight,
  targetSource,
} from "./update-plan.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

type Fixture = Awaited<ReturnType<typeof createUpdatePlanFixture>>;

const packageIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// Stubbed package inspection: the fixture installs package refs without real
// ClawHub artifacts, so resolve/plan deps report every recorded package as
// present and untouched. Without these, update-plan sees "missing" packages
// and every scenario degenerates into restore actions.
const goldenPackageDeps = {
  resolvePlugin: async () => ({
    status: "found" as const,
    pluginId: "obsolete",
    installedVersion: "1.0.0",
    record: { source: "clawhub" as const, integrity: packageIntegrity },
  }),
  planSkill: async () => ({
    ok: true as const,
    plan: {
      requestedRef: "triage",
      slug: "triage",
      version: "1.0.0",
      workspaceDir: "/tmp/claw-golden-skill",
      installedAt: 1,
      targetDir: "/tmp/claw-golden-skill",
      skillFilePath: "/tmp/claw-golden-skill/SKILL.md",
      skillFileSha256: "x",
      fileTreeSha256: "x",
    },
  }),
};

async function fixture(): Promise<Fixture> {
  const root = tempDirs.make("openclaw-claw-update-golden-");
  return await createUpdatePlanFixture(root);
}

async function expectGolden(
  current: Fixture,
  params: {
    targetManifest: ClawManifest;
    targetSource?: ClawSourceIdentity;
    targetOpenClawProfile?: ClawOpenClawProfile;
    digest: string;
  },
) {
  const plan = await buildClawUpdatePlan({
    agentId: "worker",
    targetManifest: params.targetManifest,
    targetSource: params.targetSource ?? current.source,
    config: current.config,
    sourceMcpServers: current.config.mcp?.servers ?? {},
    stateOptions: { env: current.env, packageDeps: goldenPackageDeps },
    packagePreflight,
    ...(params.targetOpenClawProfile
      ? { targetOpenClawProfile: params.targetOpenClawProfile }
      : {}),
  });
  const normalized = normalizeGoldenPlan(plan, [current.root]);
  expect(normalized).toMatchSnapshot();
  expect(goldenPlanDigest(normalized)).toBe(params.digest);
}

describe("claws update-plan goldens", () => {
  it("golden: no-op target", async () => {
    const current = await fixture();
    await expectGolden(current, {
      targetManifest: current.manifest,
      digest: "sha256:9bc29d4f1cb8a5514958730dcf5bb3ec880fc3c014368652707c7c3c11826560",
    });
  });

  it("golden: full change matrix", async () => {
    const current = await fixture();
    await writeFile(join(current.root, "SOUL-v2.md"), "updated soul\n", "utf8");
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker", name: "Worker" },
      workspace: {
        bootstrapFiles: { "SOUL.md": { source: "SOUL-v2.md" } },
        files: [],
      },
      packages: [
        { kind: "skill", source: "clawhub", ref: "triage", version: "1.1.0" },
        { kind: "plugin", source: "clawhub", ref: "obsolete", version: "1.0.0" },
        { kind: "skill", source: "clawhub", ref: "audit", version: "1.0.0" },
      ],
      mcpServers: { docs: { command: "uvx", args: ["docs-mcp", "--verbose"] } },
      cronJobs: [
        {
          id: "daily",
          schedule: { cron: "0 8 * * *", timezone: "UTC" },
          session: "isolated",
          message: "Updated report",
        },
        {
          id: "weekly",
          schedule: { cron: "0 9 * * 1", timezone: "UTC" },
          session: "main",
          message: "Weekly digest",
        },
      ],
    });
    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics));
    }
    await expectGolden(current, {
      targetManifest: parsed.manifest,
      targetSource: targetSource(current.root, "2.0.0", "sha256:target"),
      targetOpenClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: { allow: ["read", "write"] },
          heartbeat: { every: "30m" },
        },
      },
      digest: "sha256:8409686a0c90df58c4bad6d66861799acac6c1d1255cb2c286d8a5954066fe5b",
    });
  });

  it("golden: local workspace drift becomes manual", async () => {
    const current = await fixture();
    await writeFile(join(current.root, "workspace-worker", "SOUL.md"), "drifted\n", "utf8");
    await expectGolden(current, {
      targetManifest: current.manifest,
      digest: "sha256:fba096929cc7845e874ad3b6198de92c77c590ca5f74a1bce8da0668aaad19ce",
    });
  });

  it("golden: missing workspace restores managed files", async () => {
    const current = await fixture();
    await rm(join(current.root, "workspace-worker"), { recursive: true, force: true });
    await expectGolden(current, {
      targetManifest: current.manifest,
      digest: "sha256:7b84dd73c5b937c32e8cc44680ed478c8e3bc0864ba9d0d22162f2546f4f9cae",
    });
  });

  it("golden: agent profile escalation", async () => {
    const current = await fixture();
    await expectGolden(current, {
      targetManifest: current.manifest,
      targetOpenClawProfile: {
        schemaVersion: 1,
        agent: {
          tools: { allow: ["read", "write"], deny: ["exec"] },
          sandbox: { mode: "non-main", scope: "agent", workspaceAccess: "ro" },
          heartbeat: { every: "15m" },
        },
      },
      digest: "sha256:453b6ec0a86872ba8e7d029e3e40cfcc4a73d5c42cfd0a546c2c922ad517dbed",
    });
  });

  it("golden: heartbeat activeHours falls back to escalation", async () => {
    const current = await fixture();
    await expectGolden(current, {
      targetManifest: current.manifest,
      targetOpenClawProfile: {
        schemaVersion: 1,
        agent: {
          heartbeat: { activeHours: { start: "09:00", end: "17:00", timezone: "UTC" } },
        },
      },
      digest: "sha256:4a2819510e9bd2c9ab63d9aa599639df21d5e9a3dbf457c7a87bea502bb1e8b0",
    });
  });

  it("golden: shared plugin pin conflict becomes manual", async () => {
    const current = await fixture();
    // A second Claw pins the same plugin at a different version, so the
    // target manifest cannot mutate the shared artifact.
    const otherParsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "other", name: "Other" },
    });
    if (!otherParsed.ok) {
      throw new Error(JSON.stringify(otherParsed.diagnostics));
    }
    const otherPlan = await buildClawAddPlan({
      manifest: otherParsed.manifest,
      source: current.source,
      context: {
        workspace: join(current.root, "workspace-other"),
        packagePreflight,
      },
    });
    persistClawPackageRef(
      otherPlan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "obsolete",
        version: "2.0.0",
        integrity: `sha256:${"b".repeat(64)}`,
      },
      { env: current.env },
    );
    await expectGolden(current, {
      targetManifest: current.manifest,
      digest: "sha256:691b8a1467bbe30b66d22bdd9c13b043878ae0f6dcdce37009e4a2fd304648b4",
    });
  });

  it("golden: unresolved cron ownership becomes manual", async () => {
    const current = await fixture();
    const database = openOpenClawStateDatabase({ env: current.env });
    database.db
      /* sqlite-allow-raw: test-only mutation simulates an incomplete scheduler write. */
      .prepare("UPDATE claw_cron_refs SET status = ?")
      .run("failed");
    await expectGolden(current, {
      targetManifest: current.manifest,
      digest: "sha256:948af631bc8f37c4c26beff0f57517050b8380d72843c6efd2d1da9d74f75ba5",
    });
  });
});
