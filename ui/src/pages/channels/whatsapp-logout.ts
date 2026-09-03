// Page-side WhatsApp logout confirmation preserves the selected account and
// Gateway owner across the operator's awaited decision.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { resolveChannelAccounts } from "../../lib/channels/index.ts";

type WhatsAppLogoutParams = {
  channels: ApplicationContext["channels"];
  getWizardAccountId: () => string | undefined;
  isCurrent: () => boolean;
};

function resolveWhatsAppLogoutAccount(
  channels: ApplicationContext["channels"],
  wizardAccountId: string | undefined,
) {
  const snapshot = channels.state.channelsSnapshot;
  const accountId = wizardAccountId ?? snapshot?.channelDefaultAccountId.whatsapp ?? "default";
  const account = resolveChannelAccounts(snapshot?.channelAccounts, "whatsapp").find(
    (candidate) => candidate.accountId === accountId,
  );
  if (!account && wizardAccountId !== undefined) {
    return null;
  }
  return {
    accountId,
    linked:
      account?.linked ??
      (wizardAccountId === undefined
        ? asNullableRecord(snapshot?.channels.whatsapp)?.linked
        : undefined),
  };
}

export async function runWhatsAppLogoutConfirmation(params: WhatsAppLogoutParams): Promise<void> {
  const account = resolveWhatsAppLogoutAccount(params.channels, params.getWizardAccountId());
  if (!account || !params.isCurrent()) {
    return;
  }
  const confirmed = await showConfirmDialog({
    title: t("channels.whatsapp.logoutConfirmTitle", { accountId: account.accountId }),
    message: t("channels.whatsapp.logoutConfirmMessage", { accountId: account.accountId }),
    confirmLabel: t("common.logout"),
    danger: true,
  });
  if (!confirmed || !params.isCurrent()) {
    return;
  }
  const currentAccount = resolveWhatsAppLogoutAccount(params.channels, params.getWizardAccountId());
  if (
    !currentAccount ||
    currentAccount.accountId !== account.accountId ||
    currentAccount.linked !== account.linked
  ) {
    return;
  }
  await params.channels.logoutWhatsApp(account.accountId);
}
