import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureCodexNativeProjectInstructions,
  snapshotCodexNativeProjectInstructionSourceIdentities,
} from "./project-doc-thread-config.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

async function captureProjectInstructions(
  params: Omit<
    Parameters<typeof captureCodexNativeProjectInstructions>[0],
    "sourceIdentitiesBeforeRequest"
  >,
) {
  return captureCodexNativeProjectInstructions({
    ...params,
    sourceIdentitiesBeforeRequest: await snapshotCodexNativeProjectInstructionSourceIdentities({
      cwd: params.cwd,
      config: params.config,
    }),
  });
}

describe("Codex native project-document snapshots", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = tempDirs.make("codex-project-doc-snapshot-");
  });

  it("preserves Codex source selection and order while excluding global instructions", async () => {
    const packageDir = path.join(workspaceDir, "packages");
    const cwd = path.join(packageDir, "worker");
    const globalInstructions = path.join(workspaceDir, ".codex", "AGENTS.md");
    const rootFallback = path.join(workspaceDir, "PROJECT.md");
    const packageOverride = path.join(packageDir, "AGENTS.override.md");
    const cwdFallback = path.join(cwd, "WORKSPACE.md");
    await fs.mkdir(path.dirname(globalInstructions), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, ".git"));
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(globalInstructions, "global policy");
    await fs.writeFile(rootFallback, "root fallback");
    await fs.writeFile(packageOverride, "package override");
    await fs.writeFile(cwdFallback, "cwd fallback");

    await expect(
      captureProjectInstructions({
        cwd,
        instructionSources: [globalInstructions, rootFallback, packageOverride, cwdFallback],
        config: { project_doc_fallback_filenames: ["PROJECT.md", "WORKSPACE.md"] },
      }),
    ).resolves.toBe(
      [
        "## OpenClaw Agent Workspace Instructions",
        "",
        "OpenClaw froze the Codex-selected root-to-working-directory project instructions that established this thread.",
        "",
        `### ${rootFallback}`,
        "",
        "root fallback",
        "",
        `### ${packageOverride}`,
        "",
        "package override",
        "",
        `### ${cwdFallback}`,
        "",
        "cwd fallback",
      ].join("\n"),
    );
  });

  it("does not rediscover project files omitted by Codex", async () => {
    const cwd = path.join(workspaceDir, "nested");
    const selected = path.join(cwd, "PROJECT.md");
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(workspaceDir, ".git"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "unselected parent policy");
    await fs.writeFile(selected, "selected custom policy");

    await expect(
      captureProjectInstructions({
        cwd,
        instructionSources: [selected],
        config: { project_doc_fallback_filenames: ["PROJECT.md"] },
      }),
    ).resolves.toBe(
      [
        "## OpenClaw Agent Workspace Instructions",
        "",
        "OpenClaw froze the Codex-selected root-to-working-directory project instructions that established this thread.",
        "",
        `### ${selected}`,
        "",
        "selected custom policy",
      ].join("\n"),
    );
  });

  it("preflights fallback candidates selected by the effective native config", async () => {
    const cwd = path.join(workspaceDir, "packages", "worker");
    const rootMarker = path.join(workspaceDir, ".workspace-root");
    const instructions = path.join(workspaceDir, "WORKFLOW.md");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(rootMarker, "");
    await fs.writeFile(instructions, "native configured authority");
    const readNativeConfig = vi.fn(async () => ({
      config: {
        project_doc_fallback_filenames: ["WORKFLOW.md"],
        project_root_markers: [".workspace-root"],
      },
      layers: [
        {
          name: { type: "user" },
          config: {
            project_doc_fallback_filenames: ["WORKFLOW.md"],
            project_root_markers: [".workspace-root"],
          },
        },
      ],
    }));
    const sourceIdentitiesBeforeRequest =
      await snapshotCodexNativeProjectInstructionSourceIdentities({
        cwd,
        config: { project_doc_max_bytes: 10 },
        readNativeConfig,
      });

    await expect(
      captureCodexNativeProjectInstructions({
        cwd,
        instructionSources: [instructions],
        config: { project_doc_max_bytes: 10 },
        sourceIdentitiesBeforeRequest,
      }),
    ).resolves.toContain("native con");
    expect(readNativeConfig).toHaveBeenCalledWith(cwd);
  });

  it("shares the configured byte budget across Codex-selected sources", async () => {
    const cwd = path.join(workspaceDir, "nested");
    const rootInstructions = path.join(workspaceDir, "AGENTS.md");
    const nestedInstructions = path.join(cwd, "AGENTS.md");
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(workspaceDir, ".git"));
    await fs.writeFile(rootInstructions, "root");
    await fs.writeFile(nestedInstructions, "nested");

    await expect(
      captureProjectInstructions({
        cwd,
        instructionSources: [rootInstructions, nestedInstructions],
        config: { project_doc_max_bytes: 7 },
      }),
    ).resolves.toBe(
      [
        "## OpenClaw Agent Workspace Instructions",
        "",
        "OpenClaw froze the Codex-selected root-to-working-directory project instructions that established this thread.",
        "",
        `### ${rootInstructions}`,
        "",
        "root",
        "",
        `### ${nestedInstructions}`,
        "",
        "nes",
      ].join("\n"),
    );
  });

  it("renders a bounded frozen snapshot from the response sources", async () => {
    const instructions = path.join(workspaceDir, "CUSTOM.md");
    await fs.writeFile(instructions, "custom authority");

    await expect(
      captureProjectInstructions({
        cwd: workspaceDir,
        instructionSources: [instructions],
        config: {
          project_doc_fallback_filenames: ["CUSTOM.md"],
          project_doc_max_bytes: 6,
        },
      }),
    ).resolves.toBe(
      [
        "## OpenClaw Agent Workspace Instructions",
        "",
        "OpenClaw froze the Codex-selected root-to-working-directory project instructions that established this thread.",
        "",
        `### ${instructions}`,
        "",
        "custom",
      ].join("\n"),
    );
  });

  it("fails closed if a Codex-selected source disappears before capture", async () => {
    const missingInstructions = path.join(workspaceDir, "AGENTS.md");

    await expect(
      captureProjectInstructions({
        cwd: workspaceDir,
        instructionSources: [missingInstructions],
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a selected local source changed after native startup began", async () => {
    const instructions = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(instructions, "original authority");
    const sourceIdentitiesBeforeRequest =
      await snapshotCodexNativeProjectInstructionSourceIdentities({ cwd: workspaceDir });
    await fs.writeFile(instructions, "changed authority");

    await expect(
      captureCodexNativeProjectInstructions({
        cwd: workspaceDir,
        instructionSources: [instructions],
        sourceIdentitiesBeforeRequest,
      }),
    ).rejects.toThrow("changed during native startup");
  });

  it("captures Codex-selected instructions from every host-local environment", async () => {
    const primaryCwd = path.join(workspaceDir, "primary");
    const secondaryCwd = path.join(workspaceDir, "secondary");
    const secondaryInstructions = path.join(secondaryCwd, "AGENTS.md");
    await fs.mkdir(primaryCwd);
    await fs.mkdir(secondaryCwd);
    await fs.writeFile(secondaryInstructions, "secondary environment authority");
    const environmentSelection = [
      { environmentId: "primary", cwd: primaryCwd },
      { environmentId: "secondary", cwd: secondaryCwd },
    ];
    const sourceIdentitiesBeforeRequest =
      await snapshotCodexNativeProjectInstructionSourceIdentities({
        cwd: primaryCwd,
        environmentSelection,
      });

    await expect(
      captureCodexNativeProjectInstructions({
        cwd: primaryCwd,
        instructionSources: [secondaryInstructions],
        sourceIdentitiesBeforeRequest,
      }),
    ).resolves.toContain("secondary environment authority");
  });

  it("uses the primary effective config for every selected environment", async () => {
    const primaryCwd = path.join(workspaceDir, "primary");
    const secondaryCwd = path.join(workspaceDir, "secondary");
    const secondaryInstructions = path.join(secondaryCwd, "PRIMARY.md");
    await fs.mkdir(primaryCwd);
    await fs.mkdir(secondaryCwd);
    await fs.writeFile(secondaryInstructions, "primary-config authority in secondary cwd");
    const readNativeConfig = vi.fn(async () => ({
      config: { project_doc_fallback_filenames: ["PRIMARY.md"] },
      layers: [],
    }));
    const sourceIdentitiesBeforeRequest =
      await snapshotCodexNativeProjectInstructionSourceIdentities({
        cwd: primaryCwd,
        environmentSelection: [
          { environmentId: "primary", cwd: primaryCwd },
          { environmentId: "secondary", cwd: secondaryCwd },
        ],
        readNativeConfig,
      });

    await expect(
      captureCodexNativeProjectInstructions({
        cwd: primaryCwd,
        instructionSources: [secondaryInstructions],
        sourceIdentitiesBeforeRequest,
      }),
    ).resolves.toContain("primary-config authority in secondary cwd");
    expect(readNativeConfig).toHaveBeenCalledTimes(1);
    expect(readNativeConfig).toHaveBeenCalledWith(primaryCwd);
  });

  it("excludes project-layer values when resolving native root markers", async () => {
    const projectDir = path.join(workspaceDir, "project");
    const cwd = path.join(projectDir, "packages", "worker");
    const instructions = path.join(workspaceDir, "PRIMARY.md");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, ".user-root"), "");
    await fs.writeFile(path.join(projectDir, ".project-root"), "");
    await fs.writeFile(instructions, "authority above the project config boundary");
    const sourceIdentitiesBeforeRequest =
      await snapshotCodexNativeProjectInstructionSourceIdentities({
        cwd,
        readNativeConfig: async () => ({
          config: {
            project_doc_fallback_filenames: ["PRIMARY.md"],
            project_root_markers: [".project-root"],
          },
          layers: [
            {
              name: { type: "project" },
              config: { project_root_markers: [".project-root"] },
            },
            {
              name: { type: "user" },
              config: { project_root_markers: [".user-root"] },
            },
          ],
        }),
      });

    await expect(
      captureCodexNativeProjectInstructions({
        cwd,
        instructionSources: [instructions],
        sourceIdentitiesBeforeRequest,
      }),
    ).resolves.toContain("authority above the project config boundary");
  });

  it("preflights managed and thread-patch root-marker precedence candidates", async () => {
    const cwd = path.join(workspaceDir, "packages", "worker");
    const instructions = path.join(workspaceDir, "AGENTS.md");
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, ".managed-root"), "");
    await fs.writeFile(path.join(workspaceDir, "packages", ".patch-root"), "");
    await fs.writeFile(instructions, "managed precedence authority");
    const sourceIdentitiesBeforeRequest =
      await snapshotCodexNativeProjectInstructionSourceIdentities({
        cwd,
        config: { project_root_markers: [".patch-root"] },
        readNativeConfig: async () => ({
          config: { project_root_markers: [".managed-root"] },
          layers: [
            {
              name: { type: "legacyManagedConfigTomlFromFile" },
              config: { project_root_markers: [".managed-root"] },
            },
          ],
        }),
      });

    await expect(
      captureCodexNativeProjectInstructions({
        cwd,
        instructionSources: [instructions],
        sourceIdentitiesBeforeRequest,
      }),
    ).resolves.toContain("managed precedence authority");
  });

  it("probes only Codex project-document candidates instead of unrelated ancestor files", async () => {
    const cwd = path.join(workspaceDir, "nested");
    const unrelated = path.join(workspaceDir, "large-unrelated-tree.txt");
    await fs.mkdir(path.join(workspaceDir, ".git"));
    await fs.mkdir(cwd);
    await fs.writeFile(unrelated, "not a project instruction");
    const stat = vi.spyOn(fs, "stat");
    try {
      await snapshotCodexNativeProjectInstructionSourceIdentities({ cwd });

      expect(
        stat.mock.calls.some(([filePath]) => path.resolve(String(filePath)) === unrelated),
      ).toBe(false);
    } finally {
      stat.mockRestore();
    }
  });

  it("accepts a selected source with a legitimate future mtime", async () => {
    const instructions = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(instructions, "authority written before startup");
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await fs.utimes(instructions, future, future);

    await expect(
      captureProjectInstructions({
        cwd: workspaceDir,
        instructionSources: [instructions],
      }),
    ).resolves.toContain("authority written before startup");
  });
});
