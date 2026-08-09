/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { confirmAndStartUpdateRuntime } from "./update-confirmation.runtime.ts";

const UPDATE_AVAILABLE: UpdateAvailable = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
};

let restoreDialogPolyfill: () => void;
let originalWebkit: PropertyDescriptor | undefined;

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected ${label} button`);
  }
  return button;
}

function installNativeBridge(): ReturnType<typeof vi.fn> {
  const postMessage = vi.fn();
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: { messageHandlers: { openclawUpdate: { postMessage } } },
  });
  return postMessage;
}

function startUpdate(
  overrides: {
    startGatewayUpdate?: () => void;
    updateAvailable?: UpdateAvailable | null;
    updateSchedule?: UpdateScheduleState | null;
    viaNativeApp?: boolean;
  } = {},
) {
  const startGatewayUpdate = vi.fn();
  const settled = confirmAndStartUpdateRuntime({
    startGatewayUpdate: overrides.startGatewayUpdate ?? startGatewayUpdate,
    updateAvailable:
      overrides.updateAvailable === undefined ? UPDATE_AVAILABLE : overrides.updateAvailable,
    updateSchedule: overrides.updateSchedule ?? null,
    viaNativeApp: overrides.viaNativeApp ?? false,
  });
  return { settled, startGatewayUpdate };
}

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
  originalWebkit = Object.getOwnPropertyDescriptor(window, "webkit");
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialogPolyfill();
  if (originalWebkit) {
    Object.defineProperty(window, "webkit", originalWebkit);
  } else {
    Reflect.deleteProperty(window, "webkit");
  }
});

it("states the target, restart impact, and both versions without starting the update", async () => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate();
  const { modal, dialog } = await getRenderedModalDialog(document.body);

  expect(dialog.getAttribute("aria-label")).toBe("Update Gateway");
  expect(modal.textContent).toContain(
    "Installs the available update on the connected Gateway and restarts it.",
  );
  expect(modal.textContent).toContain("this Control UI disconnects until the Gateway is back");
  expect(modal.textContent).toContain("Installed v1.0.0 · Available v2.0.0");
  // The confirm action names the operation; a generic "Yes" would not.
  expect(findButton("Update and restart")).toBeInstanceOf(HTMLButtonElement);
  expect(findButton("Cancel").hasAttribute("autofocus")).toBe(true);
  expect(startGatewayUpdate).not.toHaveBeenCalled();
  expect(postMessage).not.toHaveBeenCalled();

  findButton("Cancel").click();
  await settled;
});

it.each([
  { dismiss: () => findButton("Cancel").click(), name: "Cancel" },
  {
    dismiss: () => {
      const modal = document.body.querySelector("openclaw-modal-dialog");
      modal?.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true, composed: true }));
    },
    name: "Escape or modal dismissal",
  },
])("sends nothing when the operator chooses $name", async ({ dismiss }) => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate({ viaNativeApp: true });
  await getRenderedModalDialog(document.body);

  dismiss();
  await settled;

  expect(startGatewayUpdate).not.toHaveBeenCalled();
  expect(postMessage).not.toHaveBeenCalled();
});

it("starts exactly one Gateway update after an explicit confirmation", async () => {
  const { settled, startGatewayUpdate } = startUpdate();
  await getRenderedModalDialog(document.body);

  findButton("Update and restart").click();
  await settled;

  expect(startGatewayUpdate).toHaveBeenCalledOnce();
});

it("hands a confirmed update to the Mac app instead of the Gateway", async () => {
  const postMessage = installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate({ viaNativeApp: true });
  const { dialog } = await getRenderedModalDialog(document.body);

  expect(dialog.getAttribute("aria-label")).toBe("Update Mac app + Gateway");
  findButton("Update Mac app and restart").click();
  await settled;

  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "start-update" });
  expect(startGatewayUpdate).not.toHaveBeenCalled();
});

it("falls back to the Gateway when the Mac bridge disappears during confirmation", async () => {
  installNativeBridge();
  const { settled, startGatewayUpdate } = startUpdate({ viaNativeApp: true });
  await getRenderedModalDialog(document.body);

  Reflect.deleteProperty(window, "webkit");
  findButton("Update Mac app and restart").click();
  await settled;

  expect(startGatewayUpdate).toHaveBeenCalledOnce();
});

it("shows the git target when no package version is available", async () => {
  const { settled } = startUpdate({
    updateAvailable: null,
    updateSchedule: {
      target: { commitsBehind: 3, kind: "git" },
    } as unknown as UpdateScheduleState,
  });
  const { modal } = await getRenderedModalDialog(document.body);

  expect(modal.textContent).toContain("3 commits behind");

  findButton("Cancel").click();
  await settled;
});

it("keeps a repeated request from stacking a second confirmation or update", async () => {
  const first = startUpdate();
  const second = startUpdate();
  await getRenderedModalDialog(document.body);

  await second.settled;
  expect(document.body.querySelectorAll("openclaw-modal-dialog")).toHaveLength(1);
  expect(second.startGatewayUpdate).not.toHaveBeenCalled();

  findButton("Update and restart").click();
  await first.settled;
  expect(first.startGatewayUpdate).toHaveBeenCalledOnce();
});
