/* @vitest-environment jsdom */

import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { afterEach, describe, expect, it } from "vitest";
import { replaceTerminalControllerForReplay } from "./terminal-controller-lifecycle.ts";
import { createTerminalController } from "./terminal-panel.test-support.ts";

describe("replaceTerminalControllerForReplay", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("restores focus after a superseding replacement detaches the previous host", async () => {
    const shell = document.body.appendChild(document.createElement("div"));
    const root = shell.attachShadow({ mode: "open" });
    const externalInput = root.appendChild(document.createElement("input"));
    const previousHost = root.appendChild(document.createElement("div"));
    const previousControllerMock = createTerminalController();
    const replacementControllerMock = createTerminalController();
    const previousController = previousControllerMock as unknown as GhosttyTerminalController;
    const replacementController = replacementControllerMock as unknown as GhosttyTerminalController;
    const target = { controller: previousController, host: previousHost };
    let current = true;
    externalInput.focus();

    const replaced = await replaceTerminalControllerForReplay({
      target,
      createController: async (parent, options) => {
        expect(options).toEqual({ readOnly: true });
        expect(parent.style.display).toBe("block");
        expect(parent.style.visibility).toBe("hidden");
        expect(parent.inert).toBe(true);
        parent.tabIndex = 0;
        parent.focus();
        previousHost.remove();
        current = false;
        return replacementController;
      },
      replay: new Uint8Array(),
      isCurrent: () => current,
    });

    expect(replaced).toBe(false);
    expect(root.activeElement).toBe(externalInput);
    expect(target).toEqual({ controller: previousController, host: previousHost });
    expect(previousControllerMock.dispose).not.toHaveBeenCalled();
    expect(replacementControllerMock.dispose).toHaveBeenCalledOnce();
    expect(root.querySelectorAll("div")).toHaveLength(0);
  });
});
