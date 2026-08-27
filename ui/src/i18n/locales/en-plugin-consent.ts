import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Plugin-consent copy is registered when its lazy surface loads so capability
// inspection does not tax every Control UI startup.
const enPluginConsent = {
  pluginConsent: {
    widenedTitle: "What changed",
    widenedDescription: "New since your last acceptance.",
    previouslyAccepted: "Previously accepted {date}.",
    declaredTitle: "Declared capabilities",
    declaredDescription:
      "From the plugin manifest. OpenClaw validates the plugin against these declarations when it loads.",
    declaredEmpty: "No channels, providers, or tools declared in the manifest.",
    contracts: "Contracts",
    hooks: "Hooks",
    runtimeHooks:
      "Code plugins may register hooks at runtime; their hook names are not declared in the manifest.",
    mcpServers: "MCP servers",
    cliCommands: "CLI commands",
    cliBackends: "CLI backends",
    skills: "Skills",
    dangerousFlags: "Dangerous config flags",
    grantsTitle: "Your grants",
    grantsDescription:
      "Set per plugin in plugins.entries.{id}. Hooks outside these grants are blocked at load.",
    promptInjection: "Prompt injection",
    conversationAccess: "Conversation access",
    allowed: "Allowed",
    blocked: "Blocked",
    on: "On",
    off: "Off",
    grantDefault: "(default)",
    grantConfigured: "(set in config)",
    externalAccessHint: "Off by default for external plugins.",
    modelOverrides: "Model overrides",
    subagentModelOverrides: "Subagent model overrides",
    modelOverride: "Model override: {value}",
    allowedModels: "Allowed models: {models}",
    allowedCompletionModels: "Completion models: {models}",
    authProfileOverride: "Auth profile override: {value}",
    agentIdOverride: "Agent ID override: {value}",
    noOverrides: "No overrides configured",
    loading: "Loading capability details…",
    fallback: "Capability details must be available before you can approve this plugin.",
    verifiedClean: "Verified clean",
    reviewRecommended: "Review recommended",
    reviewRequired: "Review required",
    trustBlocked: "Blocked",
    scanDate: "Scanned {date}",
    integrity: "Integrity",
    sha256: "SHA-256",
    commit: "Commit",
    pinnedArtifact: "Pinned to the exact installed artifact.",
    sourceClawHub: "ClawHub",
    sourceNpm: "npm",
    sourceGit: "Git",
    sourcePath: "Local path",
    sourceArchive: "Archive",
    sourceMarketplace: "Marketplace",
    community: "Community",
    enableNamed: "Enable {name}",
  },
} satisfies TranslationMap;

export const registerPluginConsentEnglish = Object.assign(
  () => {
    en.pluginConsent = enPluginConsent.pluginConsent;
  },
  { catalog: enPluginConsent },
);
