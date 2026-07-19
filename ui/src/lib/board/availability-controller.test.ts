// @vitest-environment node
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import { BoardAvailabilityController } from "./availability-controller.ts";
import { boardProviderForSession } from "./provider.ts";

describe("BoardAvailabilityController", () => {
  it("invalidates its host when a visible session board snapshot changes", async () => {
    vi.stubGlobal("location", { search: "?mockBoard=1" });
    const provider = boardProviderForSession("agent:main:main");
    const requestUpdate = vi.fn();
    let controller: BoardAvailabilityController | undefined;
    const host: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        controller = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate,
      updateComplete: Promise.resolve(true),
    };
    controller = new BoardAvailabilityController(
      host,
      () => ["main", "agent:main:main"],
      () => provider,
    );
    controller?.hostConnected();

    await provider.applyOps([{ kind: "tab_update", tabId: "main", chatDock: "left" }]);

    expect(requestUpdate).toHaveBeenCalledOnce();
    controller?.hostDisconnected();
  });
});
