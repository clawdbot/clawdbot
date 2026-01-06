import type { Command } from "commander";

import { loadConfig } from "../config/config.js";
import { sendMessageDiscord } from "../discord/send.js";
import { sendMessageIMessage } from "../imessage/send.js";
import {
  approveProviderPairingCode,
  listProviderPairingRequests,
  type PairingProvider,
} from "../pairing/pairing-store.js";
import { sendMessageSignal } from "../signal/send.js";
import { sendMessageSlack } from "../slack/send.js";
import { sendMessageTelegram } from "../telegram/send.js";
import { resolveTelegramToken } from "../telegram/token.js";

const PROVIDERS: PairingProvider[] = [
  "telegram",
  "signal",
  "imessage",
  "discord",
  "slack",
  "whatsapp",
];

function parseProvider(raw: unknown): PairingProvider {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if ((PROVIDERS as string[]).includes(value)) return value as PairingProvider;
  throw new Error(
    `Invalid provider: ${value || "(empty)"} (expected one of: ${PROVIDERS.join(", ")})`,
  );
}

async function notifyApproved(provider: PairingProvider, id: string) {
  const message =
    "✅ Clawdbot access approved. Send a message to start chatting.";
  if (provider === "telegram") {
    const cfg = loadConfig();
    const { token } = resolveTelegramToken(cfg);
    if (!token) throw new Error("telegram token not configured");
    await sendMessageTelegram(id, message, { token });
    return;
  }
  if (provider === "discord") {
    await sendMessageDiscord(`user:${id}`, message);
    return;
  }
  if (provider === "slack") {
    await sendMessageSlack(`user:${id}`, message);
    return;
  }
  if (provider === "signal") {
    await sendMessageSignal(id, message);
    return;
  }
  if (provider === "imessage") {
    await sendMessageIMessage(id, message);
    return;
  }
  // WhatsApp: approval still works (store); notifying requires an active web session.
}

export function registerPairingCli(program: Command) {
  const pairing = program
    .command("pairing")
    .description("Secure DM pairing (approve inbound requests)");

  pairing
    .command("list")
    .description("List pending pairing requests")
    .requiredOption(
      "--provider <provider>",
      `Provider (${PROVIDERS.join(", ")})`,
    )
    .option("--json", "Print JSON", false)
    .action(async (opts) => {
      const provider = parseProvider(opts.provider);
      const requests = await listProviderPairingRequests(provider);
      if (opts.json) {
        console.log(JSON.stringify({ provider, requests }, null, 2));
        return;
      }
      if (requests.length === 0) {
        console.log(`No pending ${provider} pairing requests.`);
        return;
      }
      for (const r of requests) {
        const meta = r.meta ? JSON.stringify(r.meta) : "";
        console.log(
          `${r.code}  id=${r.id}${meta ? `  meta=${meta}` : ""}  ${r.createdAt}`,
        );
      }
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that sender")
    .requiredOption(
      "--provider <provider>",
      `Provider (${PROVIDERS.join(", ")})`,
    )
    .argument("<code>", "Pairing code (shown to the requester)")
    .option("--notify", "Notify the requester on the same provider", false)
    .action(async (code, opts) => {
      const provider = parseProvider(opts.provider);
      const approved = await approveProviderPairingCode({
        provider,
        code: String(code),
      });
      if (!approved) {
        throw new Error(`No pending pairing request found for code: ${code}`);
      }

      console.log(`Approved ${provider} sender ${approved.id}.`);

      if (!opts.notify) return;
      await notifyApproved(provider, approved.id).catch((err) => {
        console.log(`Failed to notify requester: ${String(err)}`);
      });
    });
}
