/** Doctor warning for missing command owners on privileged channel commands. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { note } from "../../packages/terminal-core/src/note.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PairingChannel } from "../pairing/pairing-store.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";

/** Persist legacy channel-qualified owners before runtime compares native sender IDs. */
export function migrateLegacyCommandOwners(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const owners = cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(owners)) {
    return cfg;
  }
  let changed = false;
  const ownerAllowFrom = owners.map((entry, index) => {
    // Only the old channel:user:id envelope is unambiguous. Keep native IDs containing
    // colons (for example Matrix and workspace-qualified Slack IDs) untouched.
    const legacy =
      typeof entry === "string" ? /^([^:]+):user:([^:\s*]+)$/i.exec(entry.trim()) : null;
    const channel = legacy && normalizeChatChannelId(legacy[1]);
    if (!channel || !legacy) {
      return entry;
    }
    changed = true;
    changes.push(
      `Normalized commands.ownerAllowFrom[${index}] from ${channel}:user:id to ${channel}:id.`,
    );
    return `${channel}:${legacy[2]}`;
  });
  return changed ? { ...cfg, commands: { ...cfg.commands, ownerAllowFrom } } : cfg;
}

function resolveConfiguredCommandOwners(cfg: OpenClawConfig): string[] {
  const owners = cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(owners)) {
    return [];
  }
  return normalizeStringEntries(owners.map((entry) => String(entry ?? ""))).filter(
    (entry) => entry !== "*" && !entry.endsWith(":*"),
  );
}

/** Returns true when at least one owner sender id is configured. */
export function hasConfiguredCommandOwners(cfg: OpenClawConfig): boolean {
  return resolveConfiguredCommandOwners(cfg).length > 0;
}

/** Formats a channel sender id into the commands.ownerAllowFrom entry shape. */
export function formatCommandOwnerFromChannelSender(params: {
  channel: PairingChannel;
  id: string;
}): string | null {
  const id = normalizeOptionalString(params.id);
  if (!id) {
    return null;
  }
  const separatorIndex = id.indexOf(":");
  if (separatorIndex > 0) {
    const prefix = id.slice(0, separatorIndex);
    if (prefix.toLowerCase() === String(params.channel).toLowerCase()) {
      return id;
    }
  }
  return `${params.channel}:${id}`;
}

/** Gives admitted senders an operator-run command without granting owner authority. */
export function formatCommandOwnerHint(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  id?: string | null;
}): string {
  if (params.channel === INTERNAL_MESSAGE_CHANNEL) {
    return "Ask the operator to grant this Gateway client operator.admin access.";
  }
  const owner =
    params.channel && params.id
      ? formatCommandOwnerFromChannelSender({ channel: params.channel, id: params.id })
      : null;
  if (!owner) {
    return "Ask the operator to set commands.ownerAllowFrom to your channel user id.";
  }
  if (!params.cfg) {
    return `Ask the operator to add \`${owner}\` to \`commands.ownerAllowFrom\`.`;
  }
  const owners = JSON.stringify([
    ...new Set([...resolveConfiguredCommandOwners(params.cfg), owner]),
  ]).replaceAll("'", process.platform === "win32" ? "''" : "'\\''");
  const command = formatCliCommand("openclaw config set commands.ownerAllowFrom");
  return `Ask the operator to run \`${command} '${owners}'\` in a terminal to make this sender a command owner.`;
}

/** Emits setup guidance when privileged command ownership is not configured. */
export function noteCommandOwnerHealth(cfg: OpenClawConfig): void {
  if (hasConfiguredCommandOwners(cfg)) {
    return;
  }
  note(
    [
      "No command owner is configured.",
      "A command owner is the human operator account allowed to run owner-only commands and approve dangerous actions, including /diagnostics, /export-session, /export-trajectory, /config, and exec approvals.",
      "CLI pairing approval records the first command owner. Control UI approval has an owner checkbox; otherwise set commands.ownerAllowFrom.",
      `Fix: set commands.ownerAllowFrom to your channel user id, for example ${formatCliCommand("openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'")}`,
      "Restart the gateway after changing this if it is already running.",
    ].join("\n"),
    "Command owner",
  );
}
