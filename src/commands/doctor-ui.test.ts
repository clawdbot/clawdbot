// Doctor UI tests cover control UI asset checks, repair hints, and filesystem diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectUiProtocolFreshnessIssues,
  uiProtocolFreshnessIssueToHealthFinding,
  uiProtocolFreshnessIssueToRepairEffects,
} from "./doctor-ui.js";

const tempRoots: string[] = [];
type UiProtocolFreshnessIssue = Awaited<ReturnType<typeof detectUiProtocolFreshnessIssues>>[number];

function issue(overrides: Partial<UiProtocolFreshnessIssue> = {}): UiProtocolFreshnessIssue {
  return {
    kind: "missing-assets",
    root: "/repo/openclaw",
    uiIndexPath: "/repo/openclaw/dist/control-ui/index.html",
    canBuild: true,
    ...overrides,
  } as UiProtocolFreshnessIssue;
}

async function createOpenClawRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-ui-"));
  tempRoots.push(root);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  await fs.mkdir(path.join(root, "packages/gateway-protocol/src"), { recursive: true });
  await fs.writeFile(path.join(root, "packages/gateway-protocol/src/schema.ts"), "export {};\n");
  return root;
}

async function touch(filePath: string, date: Date): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "");
  await fs.utimes(filePath, date, date);
}

describe("UI protocol freshness health mapping", () => {
  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("maps missing UI assets to a structured finding and dry-run effect", () => {
    const current = issue();

    expect(uiProtocolFreshnessIssueToHealthFinding(current)).toEqual(
      expect.objectContaining({
        checkId: "core/doctor/ui-protocol-freshness",
        severity: "warning",
        path: "/repo/openclaw/dist/control-ui/index.html",
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    );
    expect(uiProtocolFreshnessIssueToRepairEffects(current)).toEqual([
      {
        kind: "process",
        action: "would-build-control-ui",
        target: "/repo/openclaw",
        dryRunSafe: false,
      },
    ]);
  });

  it("maps stale UI assets to rebuild effects without file diffs", () => {
    const current = issue({
      kind: "stale-assets",
      changesSinceBuild: ["abc123 schema change"],
    });
    const finding = uiProtocolFreshnessIssueToHealthFinding(current);

    expect(finding.message).toContain("abc123 schema change");
    expect(finding.fixHint).toContain("openclaw doctor --fix --force");
    expect(uiProtocolFreshnessIssueToRepairEffects(current)).toEqual([
      {
        kind: "process",
        action: "would-rebuild-control-ui",
        target: "/repo/openclaw",
        dryRunSafe: false,
      },
    ]);
  });

  it("does not report dry-run effects when UI sources are unavailable", () => {
    expect(uiProtocolFreshnessIssueToRepairEffects(issue({ canBuild: false }))).toEqual([]);
  });

  it("does not report stale assets when git finds no schema changes", async () => {
    const root = await createOpenClawRoot();
    const schemaPath = path.join(root, "packages/gateway-protocol/src/schema.ts");
    const uiIndexPath = path.join(root, "dist/control-ui/index.html");
    await touch(uiIndexPath, new Date("2026-01-01T00:00:00.000Z"));
    await touch(schemaPath, new Date("2026-01-02T00:00:00.000Z"));

    await expect(
      detectUiProtocolFreshnessIssues({
        root,
        async collectChangesSinceBuild() {
          return [];
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not report stale assets when git history is unavailable", async () => {
    const root = await createOpenClawRoot();
    const schemaPath = path.join(root, "packages/gateway-protocol/src/schema.ts");
    const uiIndexPath = path.join(root, "dist/control-ui/index.html");
    await touch(uiIndexPath, new Date("2026-01-01T00:00:00.000Z"));
    await touch(schemaPath, new Date("2026-01-02T00:00:00.000Z"));

    await expect(
      detectUiProtocolFreshnessIssues({
        root,
        async collectChangesSinceBuild() {
          return null;
        },
      }),
    ).resolves.toEqual([]);
  });
});
