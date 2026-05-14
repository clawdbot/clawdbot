import { defineCommandDescriptorCatalog } from "./command-descriptor-utils.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
import { isPrivateQaCliEnabled } from "./private-qa-cli.js";

export type SubCliDescriptor = NamedCommandDescriptor;

const subCliCommandCatalog = defineCommandDescriptorCatalog([
  { name: "acp", description: "Run and manage ACP-backed coding agents", hasSubcommands: true },
  {
    name: "gateway",
    description: "Run, inspect, and query the OpenClaw Gateway",
    hasSubcommands: true,
  },
  {
    name: "daemon",
    description: "Manage the Gateway service (legacy alias)",
    hasSubcommands: true,
  },
  { name: "logs", description: "Tail Gateway logs locally or via RPC", hasSubcommands: false },
  {
    name: "system",
    description: "System events, heartbeat, and presence",
    hasSubcommands: true,
  },
  {
    name: "models",
    description: "List, scan, and set model providers",
    hasSubcommands: true,
  },
  {
    name: "infer",
    description: "Run provider-backed model, media, search, and embedding commands",
    hasSubcommands: true,
  },
  {
    name: "capability",
    description: "Run provider capability commands (fallback alias: infer)",
    hasSubcommands: true,
  },
  {
    name: "approvals",
    description: "Manage exec approvals (gateway or node host)",
    hasSubcommands: true,
    parentDefaultHelp: true,
  },
  {
    name: "exec-policy",
    description: "Show or synchronize requested exec policy with host approvals",
    hasSubcommands: true,
  },
  {
    name: "nodes",
    description: "Pair nodes and run node-host commands through the Gateway",
    hasSubcommands: true,
  },
  {
    name: "devices",
    description: "Device pairing + token management",
    hasSubcommands: true,
    parentDefaultHelp: true,
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
    description: "Schedule and inspect Gateway background jobs",
    hasSubcommands: true,
    parentDefaultHelp: true,
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
    description: "Install, enable, disable, and inspect plugins",
    hasSubcommands: true,
    parentDefaultHelp: true,
  },
  {
    name: "channels",
    description: "Add, remove, login, and inspect messaging channels",
    hasSubcommands: true,
    parentDefaultHelp: true,
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
    description: "Audit, apply, and reload SecretRef-backed credentials",
    hasSubcommands: true,
  },
  {
    name: "skills",
    description: "List, inspect, and install agent skills",
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

export function getSubCliParentDefaultHelpCommands(): string[] {
  const commands = subCliCommandCatalog.getParentDefaultHelpCommands();
  if (isPrivateQaCliEnabled()) {
    return commands;
  }
  return commands.filter((command) => command !== "qa");
}
