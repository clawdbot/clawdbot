// Migrate Hermes tests cover apply result identity.
import path from "node:path";
import type { MigrationPlan } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHermesPlan } from "./apply.js";
import { makeContext } from "./test/provider-helpers.js";

let testWorkspace: TempWorkspace;

describe("Hermes migration apply identity", () => {
  beforeEach(async () => {
    testWorkspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-migrate-hermes-",
    });
  });

  afterEach(async () => {
    await testWorkspace.cleanup();
  });

  it("keeps results separate when report item ids repeat", async () => {
    const root = testWorkspace.dir;
    const source = path.join(root, "hermes");
    const stateDir = path.join(root, "state");
    const workspaceDir = path.join(root, "workspace");
    const plan: MigrationPlan = {
      providerId: "hermes",
      source,
      items: [
        {
          id: "manual:repeated",
          kind: "manual",
          action: "manual",
          status: "planned",
          reason: "first follow-up",
        },
        {
          id: "manual:repeated",
          kind: "manual",
          action: "manual",
          status: "planned",
          reason: "second follow-up",
        },
      ],
      summary: {
        total: 2,
        planned: 2,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
    };

    const result = await applyHermesPlan({
      ctx: makeContext({ source, stateDir, workspaceDir }),
      plan,
    });

    expect(result.items.map((item) => item.reason)).toEqual([
      "first follow-up",
      "second follow-up",
    ]);
    expect(result.items.every((item) => item.status === "skipped")).toBe(true);
  });
});
