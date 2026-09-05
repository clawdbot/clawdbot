import { execFileSync } from "node:child_process";
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

async function createOpenClawRoot(prefix = "openclaw-doctor-ui-"): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
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

  it.each([
    { kind: "missing-assets", field: "message" },
    { kind: "stale-assets", field: "fixHint" },
  ] as const)(
    "runs the $kind manual repair in its source root, not cwd",
    async ({ kind, field }) => {
      const root = await createOpenClawRoot("openclaw-doctor-ui-owner's source-");
      const unrelated = await createOpenClawRoot();
      for (const directory of [root, unrelated]) {
        await fs.writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: "openclaw",
            private: true,
            scripts: { "ui:build": "node build.cjs" },
          }),
        );
        await fs.writeFile(
          path.join(directory, "build.cjs"),
          'require("node:fs").writeFileSync("built-root.txt", process.cwd());\n',
        );
      }
      await touch(path.join(root, "ui/package.json"), new Date("2026-01-01"));
      if (kind === "stale-assets") {
        await touch(path.join(root, "dist/control-ui/index.html"), new Date("2026-01-01"));
      }
      const findings = await detectUiProtocolFreshnessIssues({
        root,
        cwd: unrelated,
        collectChangesSinceBuild: async () => ["abc123 protocol changed"],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe(kind);
      const finding = uiProtocolFreshnessIssueToHealthFinding(findings[0]!);
      const command = finding[field]?.match(/pnpm [^`\n]+/u)?.[0];
      expect(command).toBeDefined();

      const windows = process.platform === "win32";
      execFileSync(
        windows ? "powershell.exe" : "/bin/sh",
        windows
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command!]
          : ["-c", command!],
        { cwd: unrelated, timeout: 10_000, stdio: "pipe" },
      );

      await expect(
        fs.readFile(path.join(unrelated, "built-root.txt"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(root, "built-root.txt"), "utf8")).resolves.toBe(root);
    },
  );

  it("does not report dry-run effects when UI sources are unavailable", () => {
    expect(uiProtocolFreshnessIssueToRepairEffects(issue({ canBuild: false }))).toEqual([]);
  });

  it("reports missing packaged UI assets without requiring unpublished protocol sources", async () => {
    const root = await createOpenClawRoot();
    await fs.rm(path.join(root, "packages"), { recursive: true });

    await expect(detectUiProtocolFreshnessIssues({ root })).resolves.toEqual([
      {
        kind: "missing-assets",
        root,
        uiIndexPath: path.join(root, "dist/control-ui/index.html"),
        canBuild: false,
      },
    ]);
  });

  it("gives packaged installs an actionable recovery hint instead of a missing build command", () => {
    const finding = uiProtocolFreshnessIssueToHealthFinding(issue({ canBuild: false }));

    expect(finding.message).not.toContain("pnpm ui:build");
    expect(finding.fixHint).toContain("Reinstall OpenClaw");
  });

  it("keeps healthy packaged UI assets quiet without probing unpublished protocol history", async () => {
    const root = await createOpenClawRoot();
    await fs.rm(path.join(root, "packages"), { recursive: true });
    await touch(path.join(root, "dist/control-ui/index.html"), new Date("2026-01-02"));
    let checkedHistory = false;

    await expect(
      detectUiProtocolFreshnessIssues({
        root,
        async collectChangesSinceBuild() {
          checkedHistory = true;
          return ["abc123 unavailable packaged source"];
        },
      }),
    ).resolves.toEqual([]);
    expect(checkedHistory).toBe(false);
  });

  it.each([
    ["a nested schema module", "schema/sessions.ts"],
    ["the protocol package entrypoint", "index.ts"],
  ])("reports stale assets after changes to %s", async (_description, changedProtocolFile) => {
    const root = await createOpenClawRoot();
    const uiIndexPath = path.join(root, "dist/control-ui/index.html");
    const schemaBarrelPath = path.join(root, "packages/gateway-protocol/src/schema.ts");
    await touch(schemaBarrelPath, new Date("2026-01-01T00:00:00.000Z"));
    await touch(uiIndexPath, new Date("2026-01-02T00:00:00.000Z"));
    await touch(path.join(root, "ui/package.json"), new Date("2026-01-02T00:00:00.000Z"));
    await touch(
      path.join(root, "packages/gateway-protocol/src", changedProtocolFile),
      new Date("2026-01-03T00:00:00.000Z"),
    );

    await expect(
      detectUiProtocolFreshnessIssues({
        root,
        async collectChangesSinceBuild() {
          return [`abc123 changed ${changedProtocolFile}`];
        },
      }),
    ).resolves.toEqual([
      {
        kind: "stale-assets",
        root,
        uiIndexPath,
        canBuild: true,
        changesSinceBuild: [`abc123 changed ${changedProtocolFile}`],
      },
    ]);
  });

  it("reads committed nested protocol changes from the real complete-package git pathspec", async () => {
    const root = await createOpenClawRoot();
    const uiIndexPath = path.join(root, "dist/control-ui/index.html");
    await touch(path.join(root, "packages/gateway-protocol/src/schema.ts"), new Date("2026-01-01"));
    await touch(uiIndexPath, new Date("2026-01-02"));
    await touch(path.join(root, "ui/package.json"), new Date("2026-01-02"));
    await touch(
      path.join(root, "packages/gateway-protocol/src/schema/sessions.ts"),
      new Date("2026-01-03"),
    );
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "add", "packages/gateway-protocol/src/schema/sessions.ts"]);
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=Doctor UI Test",
        "-c",
        "user.email=doctor-ui@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "update nested protocol schema",
      ],
      {
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: "2026-01-03T00:00:00Z",
          GIT_COMMITTER_DATE: "2026-01-03T00:00:00Z",
        },
      },
    );

    await expect(detectUiProtocolFreshnessIssues({ root })).resolves.toEqual([
      expect.objectContaining({
        kind: "stale-assets",
        changesSinceBuild: [expect.stringMatching(/update nested protocol schema$/)],
      }),
    ]);
  });

  it("does not report stale assets when git finds no schema changes", async () => {
    const root = await createOpenClawRoot();
    const schemaPath = path.join(root, "packages/gateway-protocol/src/schema.ts");
    const uiIndexPath = path.join(root, "dist/control-ui/index.html");
    await touch(uiIndexPath, new Date("2026-01-01T00:00:00.000Z"));
    await touch(schemaPath, new Date("2026-01-02T00:00:00.000Z"));
    await touch(path.join(root, "ui/package.json"), new Date("2026-01-01T00:00:00.000Z"));

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
    await touch(path.join(root, "ui/package.json"), new Date("2026-01-01T00:00:00.000Z"));

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
