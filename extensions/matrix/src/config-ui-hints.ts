import { createChannelConfigUiHints } from "openclaw/plugin-sdk/channel-core";
// Matrix helper module supports config ui hints behavior.
import type { ChannelConfigUiHint } from "openclaw/plugin-sdk/channel-core";

export const matrixChannelConfigUiHints = {
  joinIntro: {
    label: "Matrix Group Join Introduction",
    help: "Post one brief introduction when the bot joins an allowed group room (default: true). Account settings override the channel-wide setting.",
  },
  ...createChannelConfigUiHints({
    channelLabel: "Matrix",
    mentionPatterns: {
      targetDescription: "Matrix room IDs",
      policyNote:
        "Native Matrix mention evidence still triggers even when regex patterns are denied.",
      denyNote: "Native mention evidence still triggers.",
    },
  }),
  allowBots: {
    label: "Matrix Allow Bot Messages",
    help: 'Allow messages from other configured Matrix bot accounts to trigger replies (default: false). Set "mentions" to require a visible room mention.',
  },
  botLoopProtection: {
    label: "Matrix Bot Loop Protection",
    help: "Sliding-window guard for accepted Matrix configured-bot loops. Default is enabled whenever allowBots lets configured bot messages reach dispatch.",
  },
  "botLoopProtection.enabled": {
    label: "Matrix Bot Loop Protection Enabled",
    help: 'Enable the bot-pair loop guard. Defaults to true when allowBots is true or "mentions", and false when configured bot messages are ignored.',
  },
  "botLoopProtection.maxEventsPerWindow": {
    label: "Matrix Bot Loop Events per Window",
    help: "Maximum accepted bot-pair messages within the sliding window before suppression starts. Default: 20.",
  },
  "botLoopProtection.windowSeconds": {
    label: "Matrix Bot Loop Window Seconds",
    help: "Sliding window length for counting bot-pair messages. Default: 60.",
  },
  "botLoopProtection.cooldownSeconds": {
    label: "Matrix Bot Loop Cooldown Seconds",
    help: "How long to suppress the bot pair after it exceeds the budget. Default: 60.",
  },
  dangerouslyAllowNameMatching: {
    label: "Matrix Display Name Matching",
    help: "Compatibility opt-in for resolving Matrix display names and joined room names in allowlists. Prefer full @user:server IDs and room IDs or aliases because names are mutable.",
  },
  turnTaking: {
    label: "Matrix Intelligent Turn-Taking",
    help: "Enable one shared AI-guided participation decision in Matrix rooms containing at least two joined local OpenClaw agent accounts. For plugin agent runtimes, fresh-message finalization at redraft depth 1 or 2 requires OpenClaw's registry-attested bundled Codex harness. This identifies the harness, not one exact Codex version. Off by default.",
  },
  "turnTaking.enabled": {
    label: "Matrix Intelligent Turn-Taking Enabled",
    help: "Apply intelligent participation channel-wide to eligible Matrix rooms. Fresh-message checks are added only when redraft depth is 1 or 2. True one-human/one-agent rooms are excluded.",
  },
  "turnTaking.redraftDepth": {
    label: "Matrix Fresh-Message Redraft Depth",
    help: "0 keeps participation classification but disables pre-send freshness and works with other agent runtimes. 1 or 2 uses a supported embedded or CLI finalizer; among plugin harnesses, OpenClaw's registry-attested bundled Codex harness is required. Normal minimum-version compatibility still applies.",
  },
  "turnTaking.nextStep": {
    label: "Matrix Fresh-Message Next Step",
    help: "With redraft depth 1 or 2, choose AI selection or a fixed action when newer room activity arrives before delivery.",
  },
  "turnTaking.nextStep.decider": {
    label: "Matrix Next-Step Decider",
    help: "AI dynamically chooses redraft, discard, or send-as-is. User uses the configured fixed action.",
  },
  "turnTaking.nextStep.action": {
    label: "Matrix Fixed Next-Step Action",
    help: "Required only when decider is user: redraft, discard, or send-as-is.",
  },
  ...createChannelConfigUiHints({ channelLabel: "Matrix", progress: {} }),
} satisfies Record<string, ChannelConfigUiHint>;
