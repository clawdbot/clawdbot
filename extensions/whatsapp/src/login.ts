import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, success } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { logInfo } from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import { restoreCredsFromBackupIfNeeded } from "./auth-store.js";
import { closeWaSocketSoon, waitForWhatsAppLoginResult } from "./connection-controller.js";
import { renderQrTerminal } from "./qr-terminal.js";
import { createWaSocket, waitForWaConnection } from "./session.js";
import { resolveWhatsAppSocketTiming } from "./socket-timing.js";

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
) {
  const cfg = getRuntimeConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const socketTiming = resolveWhatsAppSocketTiming(cfg);
  const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir);
  const onQr = (qr: string) => {
    runtime.log("Open the WhatsApp app, go to Linked Devices, then scan this QR:");
    void renderQrTerminal(qr, { small: true })
      .then((output) => {
        runtime.log(output.endsWith("\n") ? output.slice(0, -1) : output);
      })
      .catch((err) => {
        runtime.error(`failed rendering WhatsApp QR: ${String(err)}`);
      });
  };
  let sock = await createWaSocket(false, verbose, {
    authDir: account.authDir,
    ...socketTiming,
    onQr,
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
      socketTiming,
      onQr,
      onSocketReplaced: (replacementSock) => {
        sock = replacementSock;
      },
    });
    if (result.outcome === "connected") {
      runtime.log(
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
      runtime.error(
        danger(
          `WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`,
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.", {
        cause: result.error,
      });
    }

    runtime.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
    throw new Error(result.message, { cause: result.error });
  } finally {
    // Let Baileys flush any final events before closing the socket.
    closeWaSocketSoon(sock);
  }
}
