import type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { t } from "../../i18n/index.ts";

export type { ChatRunStartupPhase } from "../../../../packages/gateway-protocol/src/index.js";

export type ChatRunStartupState =
  | { state: "status"; runId: string; phase: ChatRunStartupPhase }
  | { state: "activity"; runId: string };

export type ChatRunStartupStatus = Extract<ChatRunStartupState, { state: "status" }>;

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
