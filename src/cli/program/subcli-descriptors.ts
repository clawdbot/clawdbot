import { defineCommandDescriptorCatalog } from "./command-descriptor-utils.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
import { isPrivateQaCliEnabled } from "./private-qa-cli.js";

export type SubCliDescriptor = NamedCommandDescriptor;

const subCliCommandCatalog = defineCommandDescriptorCatalog([
  { name: "acp", description: "Agent Control Protocol tools", hasSubcommands: true },
  {
    name: "gateway",
    description: "Run, inspect, and query the WebSocket Gateway",
    hasSubcommands: true,
  },
  { name: "daemon", description: "Gateway service (legacy alias)", hasSubcommands: true },
  { name: "logs", description: "Tail gateway file logs via RPC", hasSubcommands: false },
  {
    name: "system",
    description: "System events, heartbeat, and presence",
    hasSubcommands: true,
  },
  {
    name: "models",
    description: "Discover, scan, and configure models",
    hasSubcommands: true,
  },
  {
    name: "infer",
    description: "Run provider-backed inference commands",
    hasSubcommands: true,
  },
  {
    name: "capability",
    description: "Run provider-backed inference commands (fallback alias: infer)",
    hasSubcommands: true,
  },
  {
    name: "approvals",
    description: "Manage exec approvals (gateway or node host)",
    hasSubcommands: true,
  },
  {
    name: "exec-policy",
    description: "Show or synchronize requested exec policy with host approvals",
    hasSubcommands: true,
  },
  {
    name: "nodes",
    description: "Manage gateway-owned node pairing and node commands",
    hasSubcommands: true,
  },
  {
    name: "devices",
    description: "Device pairing + token management",
    hasSubcommands: true,
  },
  {
    name: "node",
    description: "Run and manage the headless node host service",
    hasSubcommands: true,
  },
  {
    name: "sandbox",
    description: "Manage sandbox containers for agent isolation",
    hasSubcommands: true,
  },
  {
    name: "tui",
    description: "Open a terminal UI connected to the Gateway",
    hasSubcommands: false,
  },
  {
    name: "terminal",
    description: "Open a local terminal UI (alias for tui --local)",
    hasSubcommands: false,
  },
  {
    name: "chat",
    description: "Open a local terminal UI (alias for tui --local)",
    hasSubcommands: false,
  },
  {
    name: "cron",
    description: "Manage cron jobs via the Gateway scheduler",
    hasSubcommands: true,
  },
  {
    name: "dns",
    description: "DNS helpers for wide-area discovery (Tailscale + CoreDNS)",
    hasSubcommands: true,
  },
  {
    name: "docs",
    description: "Search the live OpenClaw docs",
    hasSubcommands: false,
  },
  {
    name: "qa",
    description: "Run QA scenarios and launch the private QA debugger UI",
    hasSubcommands: true,
  },
  {
    name: "proxy",
    description: "Run the OpenClaw debug proxy and inspect captured traffic",
    hasSubcommands: true,
  },
  {
    name: "hooks",
    description: "Manage internal agent hooks",
    hasSubcommands: true,
  },
  {
    name: "webhooks",
    description: "Webhook helpers and integrations",
    hasSubcommands: true,
  },
  {
    name: "qr",
    description: "Generate mobile pairing QR/setup code",
    hasSubcommands: false,
  },
  {
    name: "clawbot",
    description: "Legacy clawbot command aliases",
    hasSubcommands: true,
  },
  {
    name: "pairing",
    description: "Secure DM pairing (approve inbound requests)",
    hasSubcommands: true,
  },
  {
    name: "plugins",
    description: "Manage OpenClaw plugins",
    hasSubcommands: true,
  },
  {
    name: "channels",
    description: "Manage connected chat channels (Telegram, Discord, etc.)",
    hasSubcommands: true,
  },
  {
    name: "directory",
    description: "Lookup contact and group IDs (self, peers, groups) for supported chat channels",
    hasSubcommands: true,
  },
  {
    name: "security",
    description: "Security tools and local config audits",
    hasSubcommands: true,
  },
  {
    name: "secrets",
    description: "Secrets runtime reload controls",
    hasSubcommands: true,
  },
  {
    name: "skills",
    description: "List and inspect available skills",
    hasSubcommands: true,
  },
  {
    name: "update",
    description: "Update OpenClaw and inspect update channel status",
    hasSubcommands: true,
  },
  {
    name: "completion",
    description: "Generate shell completion script",
    hasSubcommands: false,
  },
] as const satisfies ReadonlyArray<SubCliDescriptor>);

export const SUB_CLI_DESCRIPTORS = subCliCommandCatalog.descriptors;

export function getSubCliEntries(): ReadonlyArray<SubCliDescriptor> {
  const descriptors = subCliCommandCatalog.getDescriptors();
  if (isPrivateQaCliEnabled()) {
    return descriptors;
  }
  return descriptors.filter((descriptor) => descriptor.name !== "qa");
}

export function getSubCliCommandsWithSubcommands(): string[] {
  const commands = subCliCommandCatalog.getCommandsWithSubcommands();
  if (isPrivateQaCliEnabled()) {
    return commands;
  }
  return commands.filter((command) => command !== "qa");
}
