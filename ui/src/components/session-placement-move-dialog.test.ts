/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { showSessionPlacementTargetDialog } from "./session-placement-move-dialog.ts";

let restoreDialogPolyfill: () => void;

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialogPolyfill();
});

it("does not repaint a cancelled placement dialog when its catalog finishes loading", async () => {
  const catalog = createDeferred<{ profiles: []; devices: [] }>();
  const result = showSessionPlacementTargetDialog({
    mode: "move",
    sessionLabel: "Example session",
    activeRun: false,
    loadCatalog: () => catalog.promise,
  });
  const { modal } = await getRenderedModalDialog(document.body);
  const host = modal.parentElement;
  if (!host) {
    throw new Error("Expected the placement dialog's host");
  }

  modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
  await expect(result).resolves.toBeNull();
  expect(host.isConnected).toBe(false);

  catalog.resolve({ profiles: [], devices: [] });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  expect(host.childElementCount).toBe(0);
});
