import fs from "node:fs/promises";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { parseNodeWorkerWorkspaceExecInput } from "../../worker/node-workspace-protocol.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

export { NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES } from "../../worker/node-workspace-protocol.js";

export async function createNodeCarrier(root: string) {
  const home = await fs.realpath(root);
  const runtime = new NodeWorkerWorkspaceRuntime({
    root: home,
    env: { ...process.env, HOME: home, TMPDIR: home },
  });
  const binding = {
    gatewayNamespace: "gateway",
    environmentId: "environment",
    sessionId: "session",
    generation: 1,
  };
  const initial = await runtime.exec({
    ...binding,
    argv: ["node", "-e", "process.stdout.write('ready')"],
  });
  return {
    home,
    binding,
    workspace: initial.workspaceDir,
    async runWorkspaceCommand(
      command: Parameters<WorkerWorkspaceTunnelHandle["runWorkspaceCommand"]>[0],
    ) {
      command.assertCurrent?.();
      return await runtime.exec(
        parseNodeWorkerWorkspaceExecInput(
          JSON.stringify({
            ...binding,
            argv: command.argv,
            input: command.input,
            timeoutMs: command.timeoutMs,
          }),
        ),
        command.signal,
      );
    },
  };
}
