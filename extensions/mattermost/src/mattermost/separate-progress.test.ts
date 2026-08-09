import { describe, expect, it, vi } from "vitest";
import { createMattermostSeparateProgressController } from "./separate-progress.js";

function createController(params?: {
  enabled?: boolean;
  retainTerminalText?: (text: string) => Promise<boolean>;
}) {
  const retainTerminalText = vi.fn(params?.retainTerminalText ?? (async () => true));
  const logVerboseMessage = vi.fn();
  const controller = createMattermostSeparateProgressController({
    enabled: params?.enabled ?? true,
    pinnedLabel: "Progress",
    draftStream: { retainTerminalText },
    logVerboseMessage,
  });
  return { controller, retainTerminalText, logVerboseMessage };
}

describe("createMattermostSeparateProgressController", () => {
  it("pins progress text and starts reasoning immediately only when enabled", () => {
    const enabled = createController().controller;
    const disabled = createController({ enabled: false }).controller;

    expect(enabled.formatDraft("Working")).toBe("Progress\n\nWorking");
    expect(enabled.startReasoningImmediately).toBe(true);
    expect(disabled.formatDraft("Working")).toBe("Working");
    expect(disabled.startReasoningImmediately).toBe(false);
  });

  it("owns a single terminal failure update across final and turn settlement", async () => {
    const { controller, retainTerminalText } = createController();

    await controller.prepareFinal(true);
    await controller.settleFinal({ visibleReplySent: true }, true);
    await controller.settleTurnError();

    expect(retainTerminalText).toHaveBeenCalledExactlyOnceWith("Progress\n\nFailed.");
  });

  it("surfaces terminal status failure when no visible final exists", async () => {
    const { controller } = createController({
      retainTerminalText: async () => {
        throw new Error("status update failed");
      },
    });

    await expect(controller.settleFinal({ visibleReplySent: false }, false)).rejects.toThrow(
      "status update failed",
    );
  });

  it("logs terminal status failure after a visible error final", async () => {
    const { controller, logVerboseMessage } = createController({
      retainTerminalText: async () => {
        throw new Error("status update failed");
      },
    });

    await expect(controller.settleFinal({ visibleReplySent: true }, true)).resolves.toBeUndefined();
    expect(logVerboseMessage).toHaveBeenCalledWith(
      expect.stringContaining("terminal progress retry failed after visible final"),
    );
  });
});
