import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readCodeModeSkill, resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import { formatSkillsCompactForPrompt } from "../../skills/loading/skill-contract.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { applySkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import {
  createResourceCarrier,
  createResourceSource,
  NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES,
} from "./skill-resource-transfer.test-support.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function createCarrier(kind = "ssh") {
  return await createResourceCarrier(temps.make(`skill-resource-${kind}-`), kind);
}
const createSource = () => createResourceSource(temps.make("remote-skill-source-"));

async function expectRejectedResourceRequest(
  carrier: string,
  mutate: (command: WorkerWorkspaceCommand) => WorkerWorkspaceCommand,
  message:
    | string
    | RegExp = /Skill resource transfer failed|invalid worker skill resource operation/,
) {
  const { snapshot } = await createSource();
  const transport = await createCarrier(carrier);
  let initializedRoot: string | undefined;
  let injected = false;
  try {
    await expect(
      transferSkillResources({
        snapshot,
        workspaceDir: transport.workspace,
        generation: transport.generation,
        assertCurrent: () => {},
        tunnel: {
          runWorkspaceCommand: async (command) => {
            const operation = command.skillResources!.operation;
            let dispatched = command;
            if (operation.operation === "write" && !injected) {
              dispatched = mutate(command);
              injected = true;
            }
            const result = await transport.runWorkspaceCommand(dispatched);
            if (operation.operation === "init") {
              initializedRoot = JSON.parse(result.stdout).root;
            }
            return result;
          },
        },
      }),
    ).rejects.toThrow(message);
    expect(injected).toBe(true);
    await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (initializedRoot) {
      await fs.rm(initializedRoot, { recursive: true, force: true });
    }
  }
}

describe("remote-exec skill resource delivery", () => {
  it.each(
    ["ssh", "node"].flatMap((carrier) =>
      ["complete", "cancelled", "retired"].map((outcome) => ({ carrier, outcome })),
    ),
  )(
    "preserves private resources and cleans up only its current owner ($carrier, $outcome)",
    async ({ carrier, outcome }) => {
      const { workspace, filePath, binary, snapshot } = await createSource();
      const controller = new AbortController();
      const transport = await createCarrier(carrier);
      await fs.writeFile(
        path.join(transport.workspace, "project.txt"),
        "project remains unchanged\n",
      );
      const sibling = path.join(
        path.dirname(transport.workspace),
        `.${transport.generation}.skill-resources-${"a".repeat(32)}`,
      );
      await fs.mkdir(sibling);
      await fs.writeFile(path.join(sibling, "keep.txt"), "another owner");
      let current = true;
      const resources = await transferSkillResources({
        tunnel: transport,
        workspaceDir: transport.workspace,
        generation: transport.generation,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement retired");
          }
        },
        snapshot,
      });
      expect(resources).toBeDefined();
      const remote = resources!.mounts[0]!.containerPath;
      try {
        expect(remote.startsWith(workspace)).toBe(false);
        expect(path.relative(transport.workspace, remote)).toMatch(/^\.\.[/\\]/);
        expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(
          await fs.readFile(filePath),
        );
        expect(resources!.snapshot.resolvedSkills![0]!.name).toBe("source");
        expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        const executableMode = (await fs.stat(path.join(remote, "scripts/check.sh"))).mode;
        const dataMode = (await fs.stat(path.join(remote, "data.bin"))).mode;
        if (process.platform === "win32") {
          expect(executableMode & 0o222).toBe(0);
          expect(dataMode & 0o222).toBe(0);
        } else {
          expect(executableMode & 0o777).toBe(0o500);
          expect(dataMode & 0o777).toBe(0o400);
        }
        const selected = resources!.snapshot.resolvedSkills![0]!;
        const instructions = await fs.readFile(filePath, "utf8");
        expect(selected.filePath).toBe(`${remote}/SKILL.md`);
        expect(selected.baseDir).toBe(remote);
        expect(selected.sourceInfo).toEqual(snapshot.resolvedSkills![0]!.sourceInfo);
        expect(snapshot.resolvedSkills![0]!.filePath).toBe(filePath);
        for (const prompt of [
          resources!.snapshot.prompt,
          formatSkillsCompactForPrompt([selected], { descriptionMaxChars: 0 }),
        ]) {
          expect(prompt).toContain(`<location>${remote}/SKILL.md</location>`);
          expect(prompt).not.toContain(filePath);
        }
        await fs.writeFile(filePath, "Instructions changed after transfer");
        const [codeModeSkill] = resolveCodeModeSkills({
          skillsPrompt: resources!.snapshot.prompt,
          candidates: [selected],
          reader: async () => {
            throw new Error("Paired nodes have no Gateway filesystem bridge");
          },
        });
        expect(await readCodeModeSkill(codeModeSkill!)).toBe(instructions);
        expect(await fs.readFile(selected.filePath, "utf8")).toBe(instructions);
        if (carrier === "node" && outcome === "complete") {
          await expect(
            transport.runWorkspaceCommand({
              argv: ["node", "-e", "void 0", transport.home],
              transportRetry: "never",
            }),
          ).rejects.toThrow("workspace command argv resolves outside its workspace");
        }
        if (outcome === "cancelled") {
          controller.abort();
        } else if (outcome === "retired") {
          current = false;
        }
        if (outcome === "retired") {
          await expect(resources!.cleanup()).rejects.toThrow("placement retired");
          expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        } else {
          await expect(resources!.cleanup()).resolves.toBeUndefined();
          await expect(fs.stat(remote)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await fs.readFile(path.join(sibling, "keep.txt"), "utf8")).toBe("another owner");
        expect(await fs.readdir(transport.workspace)).toEqual(["project.txt"]);
        expect(await fs.readFile(path.join(transport.workspace, "project.txt"), "utf8")).toBe(
          "project remains unchanged\n",
        );
      } finally {
        await fs.rm(path.dirname(remote), { recursive: true, force: true });
      }
    },
  );

  it.each([
    { name: "forged directory", patch: { resourceId: "../outside" } },
    {
      name: "unallocated directory",
      patch: { resourceId: randomUUID().replaceAll("-", "") },
    },
    { name: "wrong inode", patch: { identity: "0:0" } },
    { name: "absolute root input", patch: { root: "/tmp" } },
    { name: "digest mismatch", patch: { sha256: "0".repeat(64) } },
    { name: "Windows alternate data stream", patch: { path: "0/data.bin:stream" } },
    { name: "Windows trailing-space parent", patch: { path: "0/.. /marker" } },
    { name: "Windows reserved device", patch: { path: "0/NUL" } },
    { name: "Windows console input", patch: { path: "0/CONIN$" } },
    { name: "Windows console output", patch: { path: "0/CONOUT$" } },
    { name: "Windows superscript COM device", patch: { path: "0/COM¹.txt" } },
    { name: "Windows superscript LPT device", patch: { path: "0/LPT³" } },
  ])("rejects $name and cleans only the allocated resources", async ({ patch }) => {
    await expectRejectedResourceRequest("node", (command) => ({
      ...command,
      skillResources: {
        ...command.skillResources!,
        operation: { ...command.skillResources!.operation, ...patch },
      },
    }));
  });

  it("rejects resource-relative traversal without writing outside its owned directory", async () => {
    const outside = await fs.realpath(temps.make("skill-resource-escape-"));
    await expectRejectedResourceRequest("node", (command) => ({
      ...command,
      skillResources: {
        ...command.skillResources!,
        operation: {
          ...command.skillResources!.operation,
          path: `../${path.basename(outside)}/marker`,
        },
      },
    }));
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it.each(["ssh", "node"])(
    "rejects an oversized typed resource request over %s",
    async (carrier) => {
      await expectRejectedResourceRequest(
        carrier,
        (command) => ({
          ...command,
          input:
            command.input! +
            " ".repeat(
              NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES + 1 - Buffer.byteLength(command.input!),
            ),
        }),
        carrier === "node"
          ? "workspace command input exceeds its bound"
          : "Skill resource transfer failed",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "omits a stale discovered skill from the transferred snapshot and prompt",
    async () => {
      const { workspace, snapshot } = await createSource();
      const staleBaseDir = path.join(workspace, "skills", "stale");
      await fs.mkdir(staleBaseDir, { recursive: true });
      await fs.writeFile(
        path.join(staleBaseDir, "SKILL.md"),
        "---\ndescription: Stale resource\n---\n# Stale\n",
      );
      const sourceSkill = snapshot.resolvedSkills?.[0];
      expect(sourceSkill).toBeDefined();
      snapshot.resolvedSkills!.push({
        ...sourceSkill!,
        name: "stale",
        filePath: path.join(staleBaseDir, "SKILL.md"),
        baseDir: staleBaseDir,
      });
      snapshot.skills.push({
        name: "stale",
        skillKey: "stale",
        primaryEnv: "STALE_SKILL_API_KEY",
      });
      snapshot.prompt += "\nstale";
      await fs.rm(staleBaseDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-stale-target"), staleBaseDir, "dir");

      const carrier = await createCarrier();
      const resources = await transferSkillResources({
        tunnel: carrier,
        workspaceDir: carrier.workspace,
        generation: carrier.generation,
        assertCurrent: () => {},
        snapshot,
      });
      const remoteRoot = path.dirname(resources!.mounts[0]!.containerPath);
      try {
        expect(resources!.mounts).toHaveLength(1);
        expect(resources!.snapshot.skills.map((skill) => skill.name)).toEqual(["source"]);
        expect(resources!.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["source"]);
        expect(resources!.snapshot.prompt).not.toContain("stale");
        const restoreEnv = applySkillEnvOverridesFromSnapshot({
          snapshot: resources!.snapshot,
          config: {
            skills: {
              entries: { stale: { apiKey: "must-not-apply" } }, // pragma: allowlist secret
            },
          },
        });
        try {
          expect(process.env.STALE_SKILL_API_KEY).toBeUndefined();
        } finally {
          restoreEnv();
        }
      } finally {
        await fs.rm(remoteRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "retains a skill identity when a same-named node skill remains active",
    async () => {
      const { workspace } = await createSource();
      const staleBaseDir = path.join(workspace, "skills", "stale");
      await fs.mkdir(staleBaseDir, { recursive: true });
      await fs.writeFile(
        path.join(staleBaseDir, "SKILL.md"),
        "---\ndescription: Stale resource\n---\n# Stale\n",
      );
      const snapshot = buildSkillSnapshot(workspace, {
        entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
      });
      const sourceSkill = snapshot.resolvedSkills?.[0];
      expect(sourceSkill).toBeDefined();
      snapshot.skills.push({ name: "stale", skillKey: "stale" });
      snapshot.resolvedSkills?.push(
        {
          ...structuredClone(sourceSkill!),
          name: "stale",
          filePath: path.join(staleBaseDir, "SKILL.md"),
          baseDir: staleBaseDir,
        },
        {
          ...structuredClone(sourceSkill!),
          name: "stale",
          filePath: "node://worker/skills/stale/SKILL.md",
          baseDir: "node://worker/skills/stale",
        },
      );
      await fs.rm(staleBaseDir, { recursive: true });
      await fs.symlink(path.join(workspace, "missing-stale-target"), staleBaseDir, "dir");

      const carrier = await createCarrier();
      const resources = await transferSkillResources({
        tunnel: carrier,
        workspaceDir: carrier.workspace,
        generation: carrier.generation,
        assertCurrent: () => {},
        snapshot,
      });
      const remoteRoot = path.dirname(resources!.mounts[0]!.containerPath);
      try {
        expect(resources!.snapshot.skills.map((skill) => skill.name)).toEqual(["source", "stale"]);
        expect(resources!.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual([
          "source",
          "stale",
        ]);
      } finally {
        await fs.rm(remoteRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "removes every stale skill from the transferred snapshot when no bundles remain",
    async () => {
      const { filePath, snapshot } = await createSource();
      const baseDir = path.dirname(filePath);
      await fs.rm(baseDir, { recursive: true });
      await fs.symlink(path.join(path.dirname(baseDir), "missing-source-target"), baseDir, "dir");

      const carrier = await createCarrier();
      const resources = await transferSkillResources({
        tunnel: carrier,
        workspaceDir: carrier.workspace,
        generation: carrier.generation,
        assertCurrent: () => {},
        snapshot,
      });
      try {
        expect(resources?.mounts).toEqual([]);
        expect(resources?.snapshot.skills).toEqual([]);
        expect(resources?.snapshot.resolvedSkills).toEqual([]);
        expect(resources?.snapshot.prompt).not.toContain("source");
      } finally {
        await resources?.cleanup();
      }
    },
  );

  it.each(["ssh", "node"])(
    "cleans the accepted remote directory when cancellation arrives with initialization (%s)",
    async (carrier) => {
      const { snapshot } = await createSource();
      const transport = await createCarrier(carrier);
      const controller = new AbortController();
      let initializedRoot: string | undefined;
      try {
        await expect(
          transferSkillResources({
            snapshot,
            workspaceDir: transport.workspace,
            generation: transport.generation,
            signal: controller.signal,
            assertCurrent: () => {},
            tunnel: {
              runWorkspaceCommand: async (command) => {
                const result = await transport.runWorkspaceCommand(command);
                if (command.skillResources!.operation.operation === "init") {
                  initializedRoot = JSON.parse(result.stdout).root;
                  controller.abort();
                }
                return result;
              },
            },
          }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(initializedRoot).toBeDefined();
        await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (initializedRoot) {
          await fs.rm(initializedRoot, { recursive: true, force: true });
        }
      }
    },
  );
});
