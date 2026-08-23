import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { formatSlackError } from "../../errors.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import { finalizeSlackPreviewEdit } from "./preview-finalize.js";

export async function collapseSlackProgressReceipt(params: {
  setup: Pick<SlackDispatchSetup, "account" | "ctx" | "slackClient">;
  edit: Omit<Parameters<typeof finalizeSlackPreviewEdit>[0], "client" | "token" | "accountId">;
}): Promise<boolean> {
  const { account, ctx, slackClient } = params.setup;
  try {
    await finalizeSlackPreviewEdit({
      client: slackClient,
      token: ctx.botToken,
      accountId: account.accountId,
      ...params.edit,
    });
    return true;
  } catch (err) {
    logVerbose(`slack: progress receipt edit failed (${formatSlackError(err)})`);
    return false;
  }
}
