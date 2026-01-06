import type { Command } from "commander";

import { loadConfig } from "../config/config.js";
import {
  approveTelegramPairingCode,
  listTelegramPairingRequests,
} from "../telegram/pairing-store.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { resolveTelegramToken } from "../telegram/token.js";

export function registerTelegramCli(program: Command) {
  const telegram = program
    .command("telegram")
    .description("Telegram helpers (pairing, allowlists)");

  const pairing = telegram
    .command("pairing")
    .description("Secure DM pairing (approve inbound requests)");

  pairing
    .command("list")
    .description("List pending Telegram pairing requests")
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const requests = await listTelegramPairingRequests();
      if (opts.json) {
        console.log(JSON.stringify({ requests }, null, 2));
        return;
      }
      if (requests.length === 0) {
        console.log("No pending Telegram pairing requests.");
        return;
      }
      for (const r of requests) {
        const name = [r.firstName, r.lastName].filter(Boolean).join(" ").trim();
        const username = r.username ? `@${r.username}` : "";
        const who = [name, username].filter(Boolean).join(" ").trim();
        console.log(
          `${r.code}  chatId=${r.chatId}${who ? `  ${who}` : ""}  ${r.createdAt}`,
        );
      }
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that chatId")
    .argument("<code>", "Pairing code (shown to the requester)")
    .option("--no-notify", "Do not notify the requester on Telegram")
    .action(async (code, opts) => {
      const approved = await approveTelegramPairingCode({ code: String(code) });
      if (!approved) {
        throw new Error(`No pending pairing request found for code: ${code}`);
      }

      console.log(`Approved Telegram chatId ${approved.chatId}.`);

      if (opts.notify === false) return;
      const cfg = loadConfig();
      const { token } = resolveTelegramToken(cfg);
      if (!token) {
        console.log(
          "Telegram token not configured; skipping requester notification.",
        );
        return;
      }
      await sendMessageTelegram(
        approved.chatId,
        "✅ Clawdbot access approved. Send a message to start chatting.",
        { token },
      ).catch((err) => {
        console.log(`Failed to notify requester: ${String(err)}`);
      });
    });
}
