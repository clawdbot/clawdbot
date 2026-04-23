import { logVerbose } from "../../globals.js";
import { buildStatusText } from "../../status/status-text.js";
import type { BuildStatusTextParams } from "../../status/status-text.types.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
export { buildStatusText } from "../../status/status-text.js";

type BuildStatusReplyParams = Omit<BuildStatusTextParams, "statusChannel"> & {
  command: CommandContext;
};

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
    }),
  };
}
