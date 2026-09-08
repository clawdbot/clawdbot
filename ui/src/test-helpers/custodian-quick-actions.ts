import type { SystemAgentChatQuestion } from "@openclaw/gateway-protocol";

export const QUICK_ACTIONS_QUESTION: SystemAgentChatQuestion = {
  id: "system-agent-quick-actions",
  header: "Quick actions",
  question: "What would you like me to do?",
  options: [
    { label: "Talk to my agent", reply: "talk to agent", recommended: true },
    { label: "Show recent changes", reply: "audit" },
  ],
};
