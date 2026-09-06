import { createDockPanelLayout } from "../dock-panel-layout.ts";

export const desktopPanelLayout = createDockPanelLayout({
  storageKey: "openclaw.desktopPanel",
  minHeight: 240,
  minWidth: 380,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 560,
});
