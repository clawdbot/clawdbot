import type { ControlUiAction, ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { createWorkboardClient } from "./api/gateway.ts";
import { t } from "./i18n/index.ts";
import type { WorkboardCapability } from "./lib/workboard/capability.ts";
import { isActiveWorkboardCard } from "./lib/workboard/card-state.ts";
import { captureSessionToWorkboard } from "./lib/workboard/session-capture.ts";
import { workboardPageTarget } from "./pages/workboard/workboard-page.ts";

export function createWorkboardSessionAction(
  host: ControlUiHost,
  workboard: WorkboardCapability,
  placement: "header" | "session",
): ControlUiAction {
  return {
    id: placement === "session" ? "capture-session" : "capture-current-session",
    label: t("sessionsView.addToWorkboard"),
    placement,
    resolve({ sessionKey, session }) {
      const row = session ?? host.sessions.rows.find((candidate) => candidate.key === sessionKey);
      const captured = workboard.state.cards.some(
        (card) =>
          isActiveWorkboardCard(card) &&
          [card.sessionKey, card.execution?.sessionKey].includes(sessionKey),
      );
      return {
        label: t(captured ? "sessionsView.openWorkboardCard" : "sessionsView.addToWorkboard"),
        disabled:
          workboard.state.dispatching || workboard.state.capturingSessionKeys.has(sessionKey),
        hidden:
          !host.connection.connected || !host.connection.canWrite || !row || row.kind === "global",
      };
    },
    async run({ sessionKey, session, host: actionHost, signal }) {
      signal.throwIfAborted();
      const row =
        session ?? actionHost.sessions.rows.find((candidate) => candidate.key === sessionKey);
      if (!row) {
        throw new Error("Refresh the session list, then add this session to Workboard again.");
      }
      const card = await captureSessionToWorkboard({
        host: workboard,
        client: createWorkboardClient(actionHost),
        session: row,
        requestUpdate: workboard.notify,
      });
      // The source page owns navigation after capture. Leaving it must not pull the user back.
      signal.throwIfAborted();
      if (!card) {
        throw new Error(
          workboard.state.error ||
            "The session could not be added to Workboard. Refresh and try again.",
        );
      }
      workboard.state.detailCardId = card.id;
      actionHost.navigation.openPage(workboardPageTarget(card.metadata?.automation?.boardId));
    },
  };
}
