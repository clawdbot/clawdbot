import { vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import type { CommandPalette } from "./command-palette.ts";

export async function mountPalette(context: ApplicationContext<RouteId>) {
  const provider = createApplicationContextProvider(context);
  const palette = document.createElement("openclaw-command-palette") as CommandPalette;
  palette.onNavigate = vi.fn();
  palette.onSelectSession = vi.fn();
  provider.append(palette);
  document.body.append(provider);
  await palette.updateComplete;
  return { palette, provider };
}

export async function enterQuery(palette: CommandPalette, query: string) {
  palette.openPalette();
  await palette.updateComplete;
  const input = palette.querySelector<HTMLInputElement>(".cmd-palette__input");
  if (!input) {
    throw new Error("Expected command palette input");
  }
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await palette.updateComplete;
}

export function findPaletteOption(palette: CommandPalette, label: string, exact = false) {
  return [...palette.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => {
    const text = item.textContent?.replace(/\s+/g, " ").trim();
    return exact ? text === label : text?.includes(label);
  });
}
