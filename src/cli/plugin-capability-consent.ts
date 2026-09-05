import {
  PLUGIN_DECLARED_SURFACE_GROUPS,
  type PluginDeclaredSurfaceGroup,
} from "../../packages/gateway-protocol/src/schema/plugin-declared-surface-groups.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import type { PluginCapabilityConsentReview } from "../plugins/capability-summary.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { promptYesNo } from "./prompt.js";

export type PluginCapabilityConsentCliOptions = {
  onCapabilityConsent?: PluginCapabilityConsentHandler;
};

const CAPABILITY_GROUP_LABELS = {
  channels: "Channels",
  providers: "Providers",
  tools: "Tools",
  contracts: "Contracts",
  hooks: "Hooks",
  mcpServers: "MCP servers",
  cliCommands: "CLI commands",
  cliBackends: "CLI backends",
  skills: "Skills",
  dangerousConfigFlags: "Dangerous configuration flags",
} satisfies Record<PluginDeclaredSurfaceGroup, string>;

function sanitizeCapabilityValues(values: readonly string[]): string {
  return values.map((value) => sanitizeTerminalText(value)).join(", ");
}

export function formatPluginCapabilityConsentLines(
  details: PluginCapabilityConsentReview,
): string[] {
  const name = sanitizeTerminalText(details.name);
  const pluginId = sanitizeTerminalText(details.pluginId);
  const version = details.version ? ` @ ${sanitizeTerminalText(details.version)}` : "";
  const lines = [`Plugin capabilities require approval: ${name} (${pluginId})${version}`];
  if (details.source) {
    const source = [details.source.kind, details.source.spec ?? details.source.packageName]
      .filter((value): value is string => Boolean(value))
      .map((value) => sanitizeTerminalText(value))
      .join(": ");
    lines.push(`Source: ${source}`);
    if (details.source.integrity) {
      lines.push(`Integrity: ${sanitizeTerminalText(details.source.integrity)}`);
    }
  }
  for (const group of PLUGIN_DECLARED_SURFACE_GROUPS) {
    const label = CAPABILITY_GROUP_LABELS[group];
    const values = details.declared[group];
    if (values.length > 0) {
      lines.push(`${label}: ${sanitizeCapabilityValues(values)}`);
    }
    const widened = details.widened?.[group];
    if (widened && widened.length > 0) {
      lines.push(`New ${label.toLowerCase()}: ${sanitizeCapabilityValues(widened)}`);
    }
  }
  lines.push(
    `Prompt injection: ${details.grants.hooks.allowPromptInjection.effective ? "allowed" : "denied"}`,
    `Conversation access: ${details.grants.hooks.allowConversationAccess.effective ? "allowed" : "denied"}`,
  );
  for (const [grantGroup, values] of [
    ["LLM", details.grants.llm],
    ["Subagent", details.grants.subagent],
  ] as const) {
    if (!values) {
      continue;
    }
    for (const [grantName, value] of Object.entries(values)) {
      const rendered = Array.isArray(value) ? sanitizeCapabilityValues(value) : String(value);
      lines.push(`${grantGroup} ${grantName}: ${rendered}`);
    }
  }
  if (details.trust) {
    lines.push(`Trust: ${details.trust.disposition}`);
    if (details.trust.reasons?.length) {
      lines.push(`Trust notes: ${sanitizeCapabilityValues(details.trust.reasons)}`);
    }
  }
  if (details.acceptedAt) {
    lines.push(`Previously accepted: ${sanitizeTerminalText(details.acceptedAt)}`);
  }
  return lines;
}

/** Resolve explicit or interactive plugin capability consent at the CLI boundary. */
export function resolvePluginCapabilityConsentCliOptions(params: {
  acceptCapabilities?: boolean;
  action: "install" | "enable" | "update" | "reload";
  allowPrompt?: boolean;
  runtime?: RuntimeEnv;
}): PluginCapabilityConsentCliOptions {
  if (params.acceptCapabilities) {
    return {
      onCapabilityConsent: async (details) => ({ reviewToken: details.reviewToken }),
    };
  }
  if (params.allowPrompt === false || !process.stdin.isTTY || !process.stdout.isTTY) {
    return {};
  }
  const runtime = params.runtime ?? defaultRuntime;
  return {
    onCapabilityConsent: async (details) => {
      for (const line of formatPluginCapabilityConsentLines(details)) {
        runtime.log(theme.warn(line));
      }
      return (await promptYesNo(
        `Accept these capabilities and ${params.action} "${sanitizeTerminalText(details.pluginId)}"?`,
      ))
        ? { reviewToken: details.reviewToken }
        : undefined;
    },
  };
}
