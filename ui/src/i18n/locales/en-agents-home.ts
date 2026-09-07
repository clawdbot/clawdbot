import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enAgentsHome = {
  agentsHome: {
    manage: "Manage agents",
    create: "New agent",
    openChat: "Open chat",
    working: "Working now",
    lastActive: "Active {time}",
    neverActive: "No recent activity",
    noMessage: "No messages yet",
    loading: "Loading agents…",
    disconnected: "Connect to the Gateway to see your agents.",
    loadFailed: "Could not load agents. Try again.",
    empty: "Your team starts here. Add an agent to get started.",
  },
} satisfies TranslationMap;

export const registerAgentsHomeEnglish = Object.assign(
  () => {
    Object.assign(en, enAgentsHome);
  },
  { catalog: enAgentsHome },
);
