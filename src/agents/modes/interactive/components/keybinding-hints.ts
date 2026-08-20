/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { interactiveAgentTheme as theme } from "../theme/theme.js";

function formatKeyPart(part: string): string {
  return process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
}

function formatKeyText(key: string): string {
  return key
    .split("/")
    .map((k) =>
      k
        .split("+")
        .map((part) => formatKeyPart(part))
        .join("+"),
    )
    .join("/");
}

function formatKeys(keys: KeyId[]): string {
  if (keys.length === 0) {
    return "";
  }
  return formatKeyText(keys.join("/"));
}

export function keyText(keybinding: Keybinding): string {
  return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyHint(keybinding: Keybinding, description: string): string {
  return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}
