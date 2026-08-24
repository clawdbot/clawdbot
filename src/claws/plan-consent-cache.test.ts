import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { readClawPlanConsent, storeClawPlanConsent } from "./plan-consent-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

function env(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

describe("claw plan consent cache", () => {
  it("stores and reads the latest plan consent per agent", async () => {
    const root = tempDirs.make("openclaw-claw-consent-");
    storeClawPlanConsent(
      { agentId: "worker", planKind: "update", planIntegrity: "sha256:first" },
      { env: env(root), nowMs: 1 },
    );
    expect(readClawPlanConsent("worker", { env: env(root) })).toEqual({
      agentId: "worker",
      planKind: "update",
      planIntegrity: "sha256:first",
      createdAtMs: 1,
    });
    expect(readClawPlanConsent("other", { env: env(root) })).toBeUndefined();
  });

  it("upserts the latest plan for the same agent", async () => {
    const root = tempDirs.make("openclaw-claw-consent-");
    storeClawPlanConsent(
      { agentId: "worker", planKind: "update", planIntegrity: "sha256:first" },
      { env: env(root), nowMs: 1 },
    );
    storeClawPlanConsent(
      { agentId: "worker", planKind: "add", planIntegrity: "sha256:second" },
      { env: env(root), nowMs: 2 },
    );
    const stored = readClawPlanConsent("worker", { env: env(root) });
    expect(stored).toMatchObject({
      planKind: "add",
      planIntegrity: "sha256:second",
      createdAtMs: 2,
    });
  });

  it("ensures the schema idempotently", async () => {
    const root = tempDirs.make("openclaw-claw-consent-");
    storeClawPlanConsent(
      { agentId: "worker", planKind: "update", planIntegrity: "sha256:first" },
      { env: env(root) },
    );
    storeClawPlanConsent(
      { agentId: "worker", planKind: "update", planIntegrity: "sha256:again" },
      { env: env(root) },
    );
    expect(readClawPlanConsent("worker", { env: env(root) })?.planIntegrity).toBe("sha256:again");
  });
});
