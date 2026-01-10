import type { Command } from "commander";

import { loadConfig } from "../config/config.js";
import { sendMessageDiscord } from "../discord/send.js";
import { sendMessageIMessage } from "../imessage/send.js";
import { sendMessageMSTeams } from "../msteams/send.js";
import { PROVIDER_ID_LABELS } from "../pairing/pairing-labels.js";
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
  "msteams",
];

function parseProvider(raw: unknown): PairingProvider {
  const value = (
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : ""
  )
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
  if (provider === "msteams") {
    const cfg = loadConfig();
    await sendMessageMSTeams({ cfg, to: id, text: message });
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
    .option("--provider <provider>", `Provider (${PROVIDERS.join(", ")})`)
    .argument("[provider]", `Provider (${PROVIDERS.join(", ")})`)
    .option("--json", "Print JSON", false)
    .action(async (providerArg, opts) => {
      const providerRaw = opts.provider ?? providerArg;
      if (!providerRaw) {
        throw new Error(
          `Provider required. Use --provider <provider> or pass it as the first argument (expected one of: ${PROVIDERS.join(", ")})`,
        );
      }
      const provider = parseProvider(providerRaw);
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
        const idLabel = PROVIDER_ID_LABELS[provider];
        console.log(
          `${r.code}  ${idLabel}=${r.id}${meta ? `  meta=${meta}` : ""}  ${r.createdAt}`,
        );
      }
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that sender")
    .option("--provider <provider>", `Provider (${PROVIDERS.join(", ")})`)
    .argument(
      "<codeOrProvider>",
      "Pairing code (or provider when using 2 args)",
    )
    .argument("[code]", "Pairing code (when provider is passed as the 1st arg)")
    .option("--notify", "Notify the requester on the same provider", false)
    .action(async (codeOrProvider, code, opts) => {
      const providerRaw = opts.provider ?? codeOrProvider;
      const resolvedCode = opts.provider ? codeOrProvider : code;
      if (!opts.provider && !code) {
        throw new Error(
          `Usage: clawdbot pairing approve <provider> <code> (or: clawdbot pairing approve --provider <provider> <code>)`,
        );
      }
      if (opts.provider && code != null) {
        throw new Error(
          `Too many arguments. Use: clawdbot pairing approve --provider <provider> <code>`,
        );
      }
      const provider = parseProvider(providerRaw);
      const approved = await approveProviderPairingCode({
        provider,
        code: String(resolvedCode),
      });
      if (!approved) {
        throw new Error(
          `No pending pairing request found for code: ${String(resolvedCode)}`,
        );
      }

      console.log(`Approved ${provider} sender ${approved.id}.`);

      if (!opts.notify) return;
      await notifyApproved(provider, approved.id).catch((err) => {
        console.log(`Failed to notify requester: ${String(err)}`);
      });
    });
}
