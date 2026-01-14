import { DisconnectReason } from "@whiskeysockets/baileys";
import { loadConfig } from "../config/config.js";
import { danger, info, success } from "../globals.js";
import { logInfo } from "../logger.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveWhatsAppAccount } from "./accounts.js";
import {
  createWaSocket,
  formatError,
  logoutWeb,
  waitForWaConnection,
} from "./session.js";

export async function loginWeb(
  verbose: boolean,
  waitForConnection?: typeof waitForWaConnection,
  runtime: RuntimeEnv = defaultRuntime,
  accountId?: string,
) {
  const wait = waitForConnection ?? waitForWaConnection;
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg, accountId });
  const sock = await createWaSocket(true, verbose, {
    authDir: account.authDir,
  });
  logInfo("Waiting for WhatsApp connection...", runtime);
  try {
    await wait(sock);
    console.log(success("✅ Linked! Credentials saved for future sends."));
  } catch (err) {
    const code =
      (err as { error?: { output?: { statusCode?: number } } })?.error?.output
        ?.statusCode ??
      (err as { output?: { statusCode?: number } })?.output?.statusCode;
    if (code === 515) {
      console.log(
        info(
          "WhatsApp asked for a restart after pairing (code 515); creds are saved. Restarting connection once…",
        ),
      );
      try {
        sock.ws?.close();
      } catch {
        // ignore
      }
      const retry = await createWaSocket(false, verbose, {
        authDir: account.authDir,
      });
      try {
        await wait(retry);
        console.log(success("✅ Linked after restart; web session ready."));
        return;
      } finally {
        setTimeout(() => retry.ws?.close(), 500);
      }
    }
    if (code === DisconnectReason.loggedOut) {
      await logoutWeb({
        authDir: account.authDir,
        isLegacyAuthDir: account.isLegacyAuthDir,
        runtime,
      });
      console.error(
        danger(
          "WhatsApp reported the session is logged out. Cleared cached web session; please rerun clawdbot channels login and scan the QR again.",
        ),
      );
      throw new Error("Session logged out; cache cleared. Re-run login.");
    }
    const formatted = formatError(err);
    console.error(
      danger(
        `WhatsApp Web connection ended before fully opening. ${formatted}`,
      ),
    );
    throw new Error(formatted);
  } finally {
    // Let Baileys flush any final events before closing the socket.
    setTimeout(() => {
      try {
        sock.ws?.close();
      } catch {
        // ignore
      }
    }, 500);
  }
}
