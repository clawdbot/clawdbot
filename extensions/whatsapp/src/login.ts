import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logInfo } from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { restoreCredsFromBackupIfNeeded } from "./auth-store.js";
import { closeWaSocketSoon, waitForWhatsAppLoginResult } from "./connection-controller.js";
import { createWaSocket, waitForWaConnection } from "./session.js";

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
) {
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir);
  let sock = await createWaSocket(true, verbose, {
    authDir: account.authDir,
  });
  logInfo("Waiting for WhatsApp connection...", runtime);
  try {
    const result = await waitForWhatsAppLoginResult({
      sock,
      authDir: account.authDir,
      isLegacyAuthDir: account.isLegacyAuthDir,
      verbose,
      runtime,
      waitForConnection,
      onSocketReplaced: (replacementSock) => {
        sock = replacementSock;
      },
    });
    if (result.outcome === "connected") {
      console.log(
        success(
          result.restarted
            ? "✅ Linked after restart; web session ready."
            : restoredFromBackup
              ? "✅ Recovered from creds.json.bak; web session ready."
              : "✅ Linked! Credentials saved for future sends.",
        ),
      );
      return;
    }

    if (result.outcome === "logged-out") {
      console.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`,
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", {
        cause: result.error,
      });
    }

    console.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
    throw new Error(result.message, { cause: result.error });
  } finally {
    // Let Baileys flush any final events before closing the socket.
    closeWaSocketSoon(sock);
  }
}
