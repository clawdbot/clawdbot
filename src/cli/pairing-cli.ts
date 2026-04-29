import type { Command } from "commander";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { listPairingChannels, notifyPairingApproved } from "../channels/plugins/pairing.js";
import {
  formatCommandOwnerFromChannelSender,
  hasConfiguredCommandOwners,
} from "../commands/doctor-command-owner.js";
import {
  getRuntimeConfig,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { resolvePairingIdLabel } from "../pairing/pairing-labels.js";
import { approveChannelPairingCode, listChannelPairingRequests } from "../pairing/pairing-store.js";
import type { PairingChannel } from "../pairing/pairing-store.types.js";
import { defaultRuntime } from "../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";

/** Parse channel, allowing extension channels not in core registry. */
function parseChannel(raw: unknown, channels: PairingChannel[]): PairingChannel {
  const value = normalizeLowercaseStringOrEmpty(normalizeStringifiedOptionalString(raw) ?? "");
  if (!value) {
    throw new Error("Channel required");
  }

  const normalized = normalizeChannelId(value);
  if (normalized) {
    if (!channels.includes(normalized)) {
      throw new Error(`Channel ${normalized} does not support pairing`);
    }
    return normalized;
  }

  // Allow extension channels: validate format but don't require registry
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(value)) {
    return value as PairingChannel;
  }
  throw new Error(`Invalid channel: ${value}`);
}

async function notifyApproved(channel: PairingChannel, id: string) {
  const cfg = getRuntimeConfig();
  await notifyPairingApproved({ channelId: channel, id, cfg });
}

async function maybeBootstrapCommandOwnerFromPairing(params: {
  channel: PairingChannel;
  id: string;
}): Promise<{ ownerEntry: string | null; bootstrapped: boolean }> {
  const ownerEntry = formatCommandOwnerFromChannelSender(params);
  if (!ownerEntry) {
    return { ownerEntry: null, bootstrapped: false };
  }

  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (hasConfiguredCommandOwners(snapshot.sourceConfig)) {
    return { ownerEntry, bootstrapped: false };
  }

  const nextConfig = structuredClone(snapshot.sourceConfig);
  nextConfig.commands = {
    ...nextConfig.commands,
    ownerAllowFrom: [ownerEntry],
  };
  await replaceConfigFile({
    nextConfig,
    snapshot,
    writeOptions,
    afterWrite: { mode: "auto" },
  });
  return { ownerEntry, bootstrapped: true };
}

export function registerPairingCli(program: Command) {
  const channels = listPairingChannels();
  const pairing = program
    .command("pairing")
    .description("Secure DM pairing (approve inbound requests)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/pairing", "docs.openclaw.ai/cli/pairing")}\n`,
    );

  pairing
    .command("list")
    .description("List pending pairing requests")
    .option("--channel <channel>", `Channel (${channels.join(", ")})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .argument("[channel]", `Channel (${channels.join(", ")})`)
    .option("--json", "Print JSON", false)
    .action(async (channelArg, opts) => {
      const channelRaw = opts.channel ?? channelArg ?? (channels.length === 1 ? channels[0] : "");
      if (!channelRaw) {
        throw new Error(
          `Channel required. Use --channel <channel> or pass it as the first argument (expected one of: ${channels.join(", ")})`,
        );
      }
      const channel = parseChannel(channelRaw, channels);
      const accountId = normalizeStringifiedOptionalString(opts.account) ?? "";
      const requests = accountId
        ? await listChannelPairingRequests(channel, process.env, accountId)
        : await listChannelPairingRequests(channel);
      if (opts.json) {
        defaultRuntime.writeJson({ channel, requests });
        return;
      }
      if (requests.length === 0) {
        defaultRuntime.log(theme.muted(`No pending ${channel} pairing requests.`));
        return;
      }
      const idLabel = resolvePairingIdLabel(channel);
      const tableWidth = getTerminalTableWidth();
      defaultRuntime.log(
        `${theme.heading("Pairing requests")} ${theme.muted(`(${requests.length})`)}`,
      );
      defaultRuntime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "Code", header: "Code", minWidth: 10 },
            { key: "ID", header: idLabel, minWidth: 12, flex: true },
            { key: "Meta", header: "Meta", minWidth: 8, flex: true },
            { key: "Requested", header: "Requested", minWidth: 12 },
          ],
          rows: requests.map((r) => ({
            Code: r.code,
            ID: r.id,
            Meta: r.meta ? JSON.stringify(r.meta) : "",
            Requested: r.createdAt,
          })),
        }).trimEnd(),
      );
    });

  pairing
    .command("approve")
    .description("Approve a pairing code and allow that sender")
    .option("--channel <channel>", `Channel (${channels.join(", ")})`)
    .option("--account <accountId>", "Account id (for multi-account channels)")
    .argument("<codeOrChannel>", "Pairing code (or channel when using 2 args)")
    .argument("[code]", "Pairing code (when channel is passed as the 1st arg)")
    .option("--notify", "Notify the requester on the same channel", false)
    .action(async (codeOrChannel, code, opts) => {
      const defaultChannel = channels.length === 1 ? channels[0] : "";
      const usingExplicitChannel = Boolean(opts.channel);
      const hasPositionalCode = code != null;
      const channelRaw = usingExplicitChannel
        ? opts.channel
        : hasPositionalCode
          ? codeOrChannel
          : defaultChannel;
      const resolvedCode = usingExplicitChannel
        ? codeOrChannel
        : hasPositionalCode
          ? code
          : codeOrChannel;
      if (!channelRaw || !resolvedCode) {
        throw new Error(
          `Usage: ${formatCliCommand("openclaw pairing approve <channel> <code>")} (or: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")})`,
        );
      }
      if (opts.channel && code != null) {
        throw new Error(
          `Too many arguments. Use: ${formatCliCommand("openclaw pairing approve --channel <channel> <code>")}`,
        );
      }
      const channel = parseChannel(channelRaw, channels);
      const accountId = normalizeStringifiedOptionalString(opts.account) ?? "";
      const approved = accountId
        ? await approveChannelPairingCode({
            channel,
            code: String(resolvedCode),
            accountId,
          })
        : await approveChannelPairingCode({
            channel,
            code: String(resolvedCode),
          });
      if (!approved) {
        throw new Error(`No pending pairing request found for code: ${String(resolvedCode)}`);
      }

      defaultRuntime.log(
        `${theme.success("Approved")} ${theme.muted(channel)} sender ${theme.command(approved.id)}.`,
      );
      const ownerBootstrap = await maybeBootstrapCommandOwnerFromPairing({
        channel,
        id: approved.id,
      });
      if (ownerBootstrap.bootstrapped && ownerBootstrap.ownerEntry) {
        defaultRuntime.log(
          `${theme.success("Command owner configured")} ${theme.command(ownerBootstrap.ownerEntry)} ${theme.muted("(commands.ownerAllowFrom was empty).")}`,
        );
      }

      if (!opts.notify) {
        return;
      }
      await notifyApproved(channel, approved.id).catch((err) => {
        defaultRuntime.log(theme.warn(`Failed to notify requester: ${String(err)}`));
      });
    });
}
