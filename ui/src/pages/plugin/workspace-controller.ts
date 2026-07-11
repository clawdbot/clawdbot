// Control UI controller for the Workspaces tab: thin lifecycle glue. All data and
// mutation logic lives in `lib/workspace`; this module exposes only the `stop`
// hook the bundled-view registry (`plugin-page.ts`) wires into tab-switch and
// disconnect cleanup (matches logbook-controller's shape).

import { stopWorkspace as stopWorkspaceLifecycle } from "../../lib/workspace/index.ts";
import { stopWorkspaceView } from "./workspace-view.ts";

/** Tears down the live-update subscription; wired into tab-switch + disconnect. */
export function stopWorkspace(host: object): void {
  stopWorkspaceLifecycle(host);
  // Drop the view-owned menu-dismiss document listeners (#3) so a tab-switch or
  // disconnect never leaves a stray global pointerdown/keydown handler.
  stopWorkspaceView(host);
}
