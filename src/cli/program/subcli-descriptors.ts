// Sub-CLI descriptor catalog used for root help placeholders and lazy registration.
import { defineCommandDescriptorCatalog } from "./command-descriptor-utils.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
import { isPrivateQaCliEnabled } from "./private-qa-cli.js";

/** Descriptor shape for root-level sub-CLI commands. */
export type SubCliDescriptor = NamedCommandDescriptor;

const subCliCommandCatalog = defineCommandDescriptorCatalog([
  { name: "acp", description: "Run an ACP bridge backed by the Gateway", hasSubcommands: true },
  {
    name: "gateway",
    description: "Run, inspect, and query the WebSocket Gateway",
    hasSubcommands: true,
  },
  {
    name: "daemon",
    description: "Manage the Gateway service (launchd/systemd/schtasks)",
    hasSubcommands: true,
  },
  { name: "logs", description: "Tail gateway file logs via RPC", hasSubcommands: false },
  {
    name: "system",
    description: "System tools (events, heartbeat, presence)",
    hasSubcommands: true,
  },
  {
    name: "models",
    description: "Model discovery, scanning, and configuration",
    hasSubcommands: true,
  },
  {
    name: "promos",
    description: "Discover and claim promotional model offers from ClawHub",
    hasSubcommands: true,
  },
  {
    name: "infer",
    description: "Run provider-backed inference commands through a stable CLI surface",
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
    name: "exec-approvals",
    description: "Manage exec approvals (alias for approvals)",
    hasSubcommands: true,
  },
  {
    name: "exec-policy",
    description: "Show or synchronize requested exec policy with host approvals",
    hasSubcommands: true,
  },
  {
    name: "nodes",
    description: "Manage gateway-owned nodes (pairing, status, invoke, and media)",
    hasSubcommands: true,
  },
  {
    name: "devices",
    description: "Device pairing and auth tokens",
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
    description: "Manage sandbox containers (Docker-based agent isolation)",
    hasSubcommands: true,
  },
  {
    name: "fleet",
    description: "Provision and manage isolated tenant cells (experimental)",
    hasSubcommands: true,
  },
  {
    name: "worktrees",
    description: "Create, inspect, restore, and clean up managed worktrees",
    hasSubcommands: true,
    parentDefaultHelp: true,
  },
  {
    name: "attach",
    description: "Attach Claude Code to a gateway session with scoped MCP tools",
    hasSubcommands: false,
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
    description: "Manage cron jobs (via Gateway)",
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
    description: "Generate a mobile pairing QR code and setup code",
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
    description: "Manage OpenClaw plugins and extensions",
    hasSubcommands: true,
    parentDefaultHelp: true,
  },
  {
    name: "channels",
    description: "Manage connected chat channels and accounts",
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
    description: "Audit local config and state for common security foot-guns",
    hasSubcommands: true,
  },
  {
    name: "secrets",
    description: "Secrets runtime controls",
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

function filterPrivateQaItems<T>(
  items: ReadonlyArray<T>,
  getName: (item: T) => string,
): ReadonlyArray<T> {
  if (isPrivateQaCliEnabled()) {
    return items;
  }
  return items.filter((item) => getName(item) !== "qa");
}

/** Visible sub-CLI descriptors after private QA gating. */
export const SUB_CLI_DESCRIPTORS = filterPrivateQaItems(
  subCliCommandCatalog.descriptors,
  (descriptor) => descriptor.name,
);

/** Return visible sub-CLI descriptors in help/registration order. */
export function getSubCliEntries(): ReadonlyArray<SubCliDescriptor> {
  return filterPrivateQaItems(
    subCliCommandCatalog.getDescriptors(),
    (descriptor) => descriptor.name,
  );
}

/** Return visible sub-CLI names that own child subcommands. */
export function getSubCliCommandsWithSubcommands(): string[] {
  return [
    ...filterPrivateQaItems(
      subCliCommandCatalog.getCommandsWithSubcommands(),
      (command) => command,
    ),
  ];
}

/** Return visible sub-CLI names whose parent command should show help by default. */
export function getSubCliParentDefaultHelpCommands(): string[] {
  return [
    ...filterPrivateQaItems(
      subCliCommandCatalog.getParentDefaultHelpCommands(),
      (command) => command,
    ),
  ];
}
