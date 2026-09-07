import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import * as processExec from "../../process/exec.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import { buildSkillResourceCommand } from "../../worker/skill-resource-receiver.js";
import type { WorkerWorkspaceCommand } from "./tunnel-contract.js";

export { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../../worker/node-workspace-protocol.js";

/** Inject a subprocess fault after the real carrier has validated and built its receiver. */
export function prependResourceReceiver(prefix: string) {
  const run = processExec.runCommandWithTimeout;
  vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation((argv, options) =>
    run(
      argv[0] === "node" && argv[1] === "-e" && argv.length === 6
        ? [...argv.slice(0, 2), prefix + argv[2], ...argv.slice(3)]
        : argv,
      options,
    ),
  );
}

export async function createResourceCarrier(root: string, kind = "ssh", generation = 1) {
  const home = await fs.realpath(root);
  const binding = {
    gatewayNamespace: "gateway",
    environmentId: "environment",
    sessionId: "session",
    generation,
  };
  const runtime =
    kind === "node"
      ? new NodeWorkerWorkspaceRuntime({
          root: home,
          env: { ...process.env, HOME: home, TMPDIR: home, TMP: home, TEMP: home },
        })
      : undefined;
  const workspace = runtime
    ? (await runtime.exec({ ...binding, argv: ["node", "-e", "process.stdout.write('ready')"] }))
        .workspaceDir
    : path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  return {
    home,
    binding,
    workspace,
    generation: binding.generation,
    async runWorkspaceCommand(command: WorkerWorkspaceCommand) {
      command.assertCurrent?.();
      const context = command.skillResources;
      if (
        context &&
        (context.workspaceDir !== workspace || context.generation !== binding.generation)
      ) {
        throw new Error("Skill resources do not match the workspace owner");
      }
      if (runtime) {
        return await runtime.exec(
          parseNodeWorkerWorkspaceExecInput(
            JSON.stringify({
              ...binding,
              argv: command.argv,
              input: command.input,
              timeoutMs: command.timeoutMs,
              ...(context ? { skillResources: context.operation } : {}),
            }),
          ),
          command.signal,
        );
      }
      const argv = context
        ? buildSkillResourceCommand({
            parentDir: path.dirname(workspace),
            generation: binding.generation,
            operation: context.operation,
          })
        : [...command.argv];
      return await processExec.runCommandWithTimeout(argv, {
        cwd: workspace,
        timeoutMs: command.timeoutMs ?? 60_000,
        input: command.input,
        signal: command.signal,
      });
    },
  };
}

export function createNodeCarrier(root: string) {
  return createResourceCarrier(root, "node");
}

export async function createResourceSource(root: string) {
  const workspace = await fs.realpath(root);
  const baseDir = path.join(workspace, "skills", "source");
  await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  await fs.writeFile(
    filePath,
    "---\ndescription: Resource transfer test\n---\n# Resource\nRead data.bin and run scripts/check.sh.\n",
  );
  const binary = Buffer.alloc(150000, 129);
  await fs.writeFile(path.join(baseDir, "data.bin"), binary);
  await fs.writeFile(path.join(baseDir, "scripts/check.sh"), "#!/bin/sh\nprintf ready\n", {
    mode: 0o700,
  });
  return {
    workspace,
    filePath,
    binary,
    snapshot: buildSkillSnapshot(workspace, {
      entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
    }),
  };
}
