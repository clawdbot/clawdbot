/** Owns local agent-command admission scopes outside a running Gateway. */
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import {
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import type { RuntimeEnv } from "../runtime.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import {
  prepareAgentCommandExecution,
  type PreparedAgentCommandExecution,
} from "./command/prepare.js";
import { resolveAgentCommandDeps } from "./command/runtime-loaders.js";
import type { AgentCommandOpts } from "./command/types.js";
import { withAgentPluginRegistry } from "./runtime-plugins.js";
import { measureAgentStartup } from "./startup-timing.js";

type ResolvedAgentCommandDeps = Awaited<ReturnType<typeof resolveAgentCommandDeps>>;

/** Runs a local command under one request, recovery, and plugin-registry generation. */
export async function runLocalAgentCommand<TResult>(params: {
  opts: AgentCommandOpts;
  runtime: RuntimeEnv;
  deps?: CliDeps;
  run: (
    prepared: PreparedAgentCommandExecution,
    resolvedDeps: ResolvedAgentCommandDeps,
  ) => Promise<TResult>;
}): Promise<TResult> {
  const resolvedDeps = await measureAgentStartup("command-dependencies", () =>
    resolveAgentCommandDeps(params.deps),
  );
  const lifecycleGeneration =
    params.opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(params.opts.runId ?? "");
  return await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    withLocalGatewayRequestScope(
      { deps: resolvedDeps, getRuntimeConfig },
      async () =>
        await runWithAgentCommandRecoveryOwner({
          lifecycleGeneration,
          mode: "reject_uncoordinated",
          opts: {
            ...params.opts,
            lifecycleGeneration,
            senderIsOwner: params.opts.senderIsOwner ?? true,
            allowModelOverride: params.opts.allowModelOverride ?? true,
          },
          prepare: async (preparedOpts) =>
            await measureAgentStartup("command-prepare", () =>
              prepareAgentCommandExecution(preparedOpts, params.runtime),
            ),
          run: async (prepared) =>
            await withAgentPluginRegistry({
              config: prepared.cfg,
              workspaceDir: prepared.workspaceDir,
              run: () => params.run(prepared, resolvedDeps),
            }),
        }),
    ),
  );
}
