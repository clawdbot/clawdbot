// Whatsapp plugin module implements account ids behavior.
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-core";

const {
  listConfiguredAccountIds,
  listAccountIds,
  resolveDefaultAccountId: resolveDefaultWhatsAppAccountId,
} = createAccountListHelpers("whatsapp", {
  implicitDefaultAccount: {
    channelKeys: ["authDir"],
  },
});

export {
  listConfiguredAccountIds,
  listAccountIds as listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
};
