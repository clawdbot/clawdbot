import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createWorkboardClient } from "./api/gateway.ts";
import { createWorkboardCatalogRuntime } from "./catalog.ts";
import { bindWorkboardHost } from "./host.ts";
import { workboardBoardLabel } from "./lib/workboard/board-presentation.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { WORKBOARD_CHANGED_EVENT } from "./lib/workboard/types.ts";
import { createWorkboardPage, workboardPageTarget } from "./pages/workboard/workboard-page.ts";
import { createWorkboardSessionAccessory } from "./session-accessory.ts";
import { createWorkboardWidget } from "./widgets.ts";
import "./styles/workboard.css";
import "./styles/widgets.css";
import "./styles/session-chip.css";

export default defineControlUiPlugin({
  id: "workboard",
  activate(host) {
    const unbind = bindWorkboardHost(host);
    const workboard = createWorkboardCapability();
    const client = createWorkboardClient(host);
    const navigation = new Map<string, { signature: string; dispose: () => void }>();
    const catalog = createWorkboardCatalogRuntime(({ boards }) => {
      const currentIds = new Set(boards.map((board) => board.id));
      for (const [id, entry] of navigation) {
        if (!currentIds.has(id)) {
          entry.dispose();
          navigation.delete(id);
        }
      }
      for (const board of boards) {
        const label = workboardBoardLabel(board);
        const signature = JSON.stringify([label, board.icon, board.color]);
        if (navigation.get(board.id)?.signature === signature) {
          continue;
        }
        navigation.get(board.id)?.dispose();
        navigation.set(board.id, {
          signature,
          dispose: host.ui.registerNavigation({
            id: `board-${board.id}`,
            label,
            page: workboardPageTarget(board.id),
            icon: board.icon,
            order: 20,
            defaultVisible: false,
          }),
        });
      }
    }, workboard);
    const registrations = [
      host.ui.registerPage({
        id: "workboard",
        label: "Workboard",
        mount: createWorkboardPage(workboard),
      }),
      host.ui.registerNavigation({
        id: "workboard",
        label: "Workboard",
        page: workboardPageTarget(),
        icon: "kanban",
        order: 10,
      }),
      host.ui.registerAccessory({
        id: "linked-card",
        placement: "session-header",
        mount: createWorkboardSessionAccessory(workboard),
      }),
      ...(["mini", "card", "board"] as const).map((id) =>
        host.ui.registerWidget({
          id,
          label:
            id === "mini"
              ? "Workboard summary"
              : id === "card"
                ? "Workboard card"
                : "Workboard board",
          mount: createWorkboardWidget(host, id),
        }),
      ),
      workboard.subscribe(host.ui.invalidate),
      host.subscribe(() => catalog.sync(client, host.connection.connected)),
      host.onEvent(WORKBOARD_CHANGED_EVENT, () =>
        catalog.handleGatewayEvent(WORKBOARD_CHANGED_EVENT),
      ),
    ];
    catalog.sync(client, host.connection.connected);
    return () => {
      for (const dispose of registrations.toReversed()) {
        dispose();
      }
      for (const { dispose } of navigation.values()) {
        dispose();
      }
      catalog.dispose();
      workboard.dispose();
      unbind();
    };
  },
});
