// Codex plugin module implements command presentation behavior.
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";

export type CodexCommandPickerButton = { label: string; command: string };

export function buildCodexCommandPickerPresentation(
  title: string,
  prompt: string,
  buttons: CodexCommandPickerButton[],
): MessagePresentation {
  return {
    title,
    blocks: [
      { type: "text", text: prompt },
      {
        type: "buttons",
        buttons: buttons.map((button) => ({
          label: button.label,
          action: { type: "command", command: button.command },
        })),
      },
    ],
  };
}
