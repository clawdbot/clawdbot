import type { createAgent } from "../agents/agent-create.js";
import { committedConfigFiles } from "./committed-config.test-support.js";

export async function createAgentForAddCommandTest(params: {
  name?: string;
  workspace?: string;
  entry?: { id: string; name?: string; workspace?: string; agentDir?: string };
  bindingSpecs?: string[];
  stagedConfig?: Parameters<typeof createAgent>[0]["stagedConfig"];
  prepareConfigCommit?: () => Promise<(() => void | Promise<void>) | void>;
}) {
  const name = params.name ?? params.entry?.name ?? params.entry?.id ?? "";
  const agentId = (params.entry?.id ?? name).toLowerCase();
  if (agentId === "openclaw" || agentId === "crestodian") {
    return { status: "error", reason: "reserved-id", agentId };
  }
  const binding = params.bindingSpecs?.[0]
    ? {
        type: "route",
        agentId,
        match: { channel: params.bindingSpecs[0].split(":")[0] },
      }
    : undefined;
  await params.prepareConfigCommit?.();
  const committed = committedConfigFiles.write(params.stagedConfig?.config ?? {});
  return {
    status: "created" as const,
    agentId,
    name,
    workspace: params.workspace ?? params.entry?.workspace ?? `/tmp/workspace-${agentId}`,
    agentDir: params.entry?.agentDir ?? `/tmp/agent-${agentId}`,
    bootstrapPending: true,
    config: committed.nextConfig,
    configPath: committed.path,
    ...(binding
      ? {
          bindingResult: {
            config: {},
            added: [],
            updated: [],
            skipped: [],
            conflicts: [{ binding, existingAgentId: "other-agent" }],
          },
        }
      : {}),
  };
}
