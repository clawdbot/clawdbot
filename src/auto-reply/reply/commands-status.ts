/** Builds /status replies using the command's authorized channel context. */
import { logVerbose } from "../../globals.js";
import { formatDetailedPluginHealth } from "../../status/status-plugin-health.js";
import { buildStatusText } from "../../status/status-text.js";
import type { BuildStatusTextParams } from "../../status/status-text.types.js";
import type { ReplyPayload } from "../types.js";
import { requireCommandFlagEnabled } from "./command-gates.js";
import type { CommandContext } from "./commands-types.js";
export { buildStatusText } from "../../status/status-text.js";

type BuildStatusReplyParams = Omit<BuildStatusTextParams, "statusChannel"> & {
  command: CommandContext;
};

/** Builds a status reply or suppresses unauthorized status requests. */
export async function buildStatusReply(
  params: BuildStatusReplyParams,
): Promise<ReplyPayload | undefined> {
  const { command } = params;
  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return undefined;
  }

  return {
    text: await buildStatusText({
      ...params,
      statusChannel: command.channel,
      statusAccountId: command.accountId,
    }),
  };
}

export async function buildStatusPluginsReply(
  params: Pick<BuildStatusReplyParams, "cfg" | "command" | "workspaceDir">,
): Promise<ReplyPayload | undefined> {
  const { command } = params;
  if (!command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /status plugins from unauthorized sender: ${command.senderId || "<unknown>"}`,
    );
    return undefined;
  }
  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/status plugins",
    configKey: "plugins",
  });
  if (disabled) {
    return disabled.reply;
  }

  try {
    const { collectInstalledPluginHealthSnapshot } =
      await import("../../status/status-plugin-health.runtime.js");
    const snapshot = await collectInstalledPluginHealthSnapshot({
      config: params.cfg,
      workspaceDir: params.workspaceDir,
    });
    return { text: formatDetailedPluginHealth(snapshot) };
  } catch (error) {
    return {
      text: `⚠️ Plugins: health unavailable (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}
