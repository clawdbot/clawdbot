import type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { t } from "../../i18n/index.ts";

export type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";

export type ChatRunStartupState =
  | { state: "status"; runId: string; phase: ChatRunStartupPhase; seq?: number }
  | { state: "activity"; runId: string };

export type ChatRunStartupStatus = Extract<ChatRunStartupState, { state: "status" }>;

/** Live status and history retain the same agent sequence; chat deltas have a separate counter. */
export function reconcileChatRunStartup(
  host: { chatRunId?: string | null; chatRunStartup?: ChatRunStartupState | null },
  next: ChatRunStartupState,
): void {
  if (host.chatRunId !== next.runId) {
    return;
  }
  const current = host.chatRunStartup;
  if (current?.runId === next.runId && next.state === "status") {
    if (
      current.state === "activity" ||
      (current.seq !== undefined && (next.seq === undefined || next.seq <= current.seq))
    ) {
      return;
    }
  }
  host.chatRunStartup = next;
}

const STARTUP_LABEL_KEYS = {
  preparing_workspace: "chat.startupStatus.preparingWorkspace",
  naming_worktree: "chat.startupStatus.namingWorktree",
  creating_worktree: "chat.startupStatus.creatingWorktree",
  running_setup: "chat.startupStatus.runningSetup",
  provisioning_environment: "chat.startupStatus.provisioningEnvironment",
  preparing_context: "chat.startupStatus.preparingContext",
  starting_model: "chat.startupStatus.startingModel",
} as const satisfies Record<ChatRunStartupPhase, Parameters<typeof t>[0]>;

export function chatStartupStatusLabel(
  run: ChatRunStartupStatus | null | undefined,
  placement: ApplicationPlacementStartupStatus | null | undefined,
): string | undefined {
  if (run) {
    return t(STARTUP_LABEL_KEYS[run.phase]);
  }
  switch (placement?.phase) {
    case "pending":
    case "requested":
    case "provisioning":
      return t("chat.startupStatus.provisioningEnvironment");
    case "syncing":
      return t("chat.startupStatus.preparingWorkspace");
    case "starting":
      return t("newSession.starting");
    case "active":
    case "sending":
      return t("chat.composer.sendingMessage");
    default:
      return undefined;
  }
}

export function activeChatRunStartupStatus(
  startup: ChatRunStartupState | null | undefined,
): ChatRunStartupStatus | null {
  return startup?.state === "status" ? startup : null;
}
