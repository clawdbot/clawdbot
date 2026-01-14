import type { Command } from "commander";
import {
  listPairingChannels,
  notifyPairingApproved,
  resolvePairingChannel,
} from "../channels/plugins/pairing.js";
import { loadConfig } from "../config/config.js";
import { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  type PairingChannel,
} from "../pairing/pairing-store.js";

const CHANNELS: PairingChannel[] = listPairingChannels();

function parseChannel(raw: unknown): PairingChannel {
  return resolvePairingChannel(raw);
}

async function notifyApproved(channel: PairingChannel, id: string) {
  const cfg = loadConfig();
  await notifyPairingApproved({ channelId: channel, id, cfg });
}

export function registerPairingCli(program: Command) {
  const pairing = program
    .command("pairing")
    .description("Secure DM pairing (approve inbound requests)");

  pairing
    .command("list")
    .description("List pending pairing requests")
    .option("--channel <channel>", `Channel (${CHANNELS.join(", ")})`)
    .argument("[channel]", `Channel (${CHANNELS.join(", ")})`)
    .option("--json", "Print JSON", false)
    .action(async (channelArg, opts) => {
      const channelRaw = opts.channel ?? channelArg;
      if (!channelRaw) {
        throw new Error(
          `Channel required. Use --channel <channel> or pass it as the first argument (expected one of: ${CHANNELS.join(", ")})`,
        );
      }
      const channel = parseChannel(channelRaw);
      const requests = await listChannelPairingRequests(channel);
      if (opts.json) {
        console.log(JSON.stringify({ channel, requests }, null, 2));
        return;
      }
      if (requests.length === 0) {
        console.log(`No pending ${channel} pairing requests.`);
        return;
      }
      for (const r of requests) {
        const meta = r.meta ? JSON.stringify(r.meta) : "";
        const idLabel = resolvePairingIdLabel(channel);
        console.log(
          `${r.code}  ${idLabel}=${r.id}${meta ? `  meta=${meta}` : ""}  ${r.createdAt}`,
        );
      }
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that sender")
    .option("--channel <channel>", `Channel (${CHANNELS.join(", ")})`)
    .argument("<codeOrChannel>", "Pairing code (or channel when using 2 args)")
    .argument("[code]", "Pairing code (when channel is passed as the 1st arg)")
    .option("--notify", "Notify the requester on the same channel", false)
    .action(async (codeOrChannel, code, opts) => {
      const channelRaw = opts.channel ?? codeOrChannel;
      const resolvedCode = opts.channel ? codeOrChannel : code;
      if (!opts.channel && !code) {
        throw new Error(
          `Usage: clawdbot pairing approve <channel> <code> (or: clawdbot pairing approve --channel <channel> <code>)`,
        );
      }
      if (opts.channel && code != null) {
        throw new Error(
          `Too many arguments. Use: clawdbot pairing approve --channel <channel> <code>`,
        );
      }
      const channel = parseChannel(channelRaw);
      const approved = await approveChannelPairingCode({
        channel,
        code: String(resolvedCode),
      });
      if (!approved) {
        throw new Error(
          `No pending pairing request found for code: ${String(resolvedCode)}`,
        );
      }

      console.log(`Approved ${channel} sender ${approved.id}.`);

      if (!opts.notify) return;
      await notifyApproved(channel, approved.id).catch((err) => {
        console.log(`Failed to notify requester: ${String(err)}`);
      });
    });
}
