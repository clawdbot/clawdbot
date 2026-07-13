export type SessionPresentation = {
  title: string;
  titleSource: "label" | "displayName" | "generated" | "worktree";
  subtitle?: string;
  family:
    | "main"
    | "direct"
    | "group"
    | "channel"
    | "thread"
    | "cron"
    | "heartbeat"
    | "subagent"
    | "acp"
    | "dashboard"
    | "tui"
    | "explicit"
    | "hook"
    | "harness"
    | "voice"
    | "dreaming"
    | "system"
    | "custom"
    | "global"
    | "unknown";
  agentId?: string;
  channel?: string;
  accountId?: string;
  peerKind?: "direct" | "group" | "channel";
  isMain: boolean;
  isBackground: boolean;
};
