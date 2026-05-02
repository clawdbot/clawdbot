/**
 * Builds an Adaptive Card for welcoming users when the bot is added to a conversation.
 */

const DEFAULT_PROMPT_STARTERS = [
  "What can you do?",
  "Summarize my last meeting",
  "Help me draft an email",
];

type WelcomeCardOptions = {
  /** Bot display name. Falls back to "OpenClaw". */
  botName?: string;
  /** Custom prompt starters. Falls back to defaults. */
  promptStarters?: string[];
};

/**
 * Build a welcome Adaptive Card for 1:1 personal chats.
 */
export function buildWelcomeCard(options?: WelcomeCardOptions): Record<string, unknown> {
  const botName = options?.botName || "OpenClaw";
  const starters = options?.promptStarters?.length
    ? options.promptStarters
    : DEFAULT_PROMPT_STARTERS;

  return {
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      {
        type: "TextBlock",
        text: `Hi! I'm ${botName}.`,
        weight: "bolder",
        size: "medium",
      },
      {
        type: "TextBlock",
        text: "I can help you with questions, tasks, and more. Here are some things to try:",
        wrap: true,
      },
    ],
    actions: starters.map((label) => ({
      type: "Action.Submit",
      title: label,
      data: { msteams: { type: "imBack", value: label } },
    })),
  };
}

/**
 * Build a brief welcome message for group chats (when the bot is @mentioned).
 */
export function buildGroupWelcomeText(botName?: string): string {
  const name = botName || "OpenClaw";
  return `Hi! I'm ${name}. Mention me with @${name} to get started.`;
}
