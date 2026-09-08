export type DockPanelSide = "bottom" | "left" | "right";
export type DockPanelPlacement = DockPanelSide | "main";

type DockPanelLayout<TDock extends DockPanelPlacement> = {
  open: boolean;
  dock: TDock;
  height: number;
  width: number;
};

export type DockPanelLayoutStore<TDock extends DockPanelPlacement> = {
  defaults: DockPanelLayout<TDock>;
  minHeight: number;
  minWidth: number;
  maxHeight(): number;
  maxWidth(): number;
  load(): DockPanelLayout<TDock>;
  save(layout: DockPanelLayout<TDock>): void;
};

type DockPanelLayoutOptions<TDock extends DockPanelPlacement> = {
  storageKey: string;
  minHeight: number;
  minWidth: number;
  defaultDock: TDock;
  supportedDocks: readonly TDock[];
  defaultHeight: number;
  defaultWidth: number;
};

export function createDockPanelLayout<TDock extends DockPanelPlacement>(
  options: DockPanelLayoutOptions<TDock>,
) {
  const defaults: DockPanelLayout<TDock> = {
    open: false,
    dock: options.defaultDock,
    height: options.defaultHeight,
    width: options.defaultWidth,
  };
  // Re-clamp desktop-persisted sizes to 80% of the current viewport so dock
  // chrome and the remaining app surface stay reachable on smaller windows.
  const maxHeight = () =>
    Math.max(options.minHeight, Math.floor((globalThis.innerHeight || 800) * 0.8));
  const maxWidth = () =>
    Math.max(options.minWidth, Math.floor((globalThis.innerWidth || 1280) * 0.8));
  const clampSize = (value: unknown, min: number, max: number, fallback: number) => {
    const size =
      typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
    return Math.min(size, max);
  };

  return {
    defaults,
    minHeight: options.minHeight,
    minWidth: options.minWidth,
    maxHeight,
    maxWidth,
    load(): DockPanelLayout<TDock> {
      try {
        const raw = globalThis.localStorage?.getItem(options.storageKey);
        if (!raw) {
          return { ...defaults };
        }
        const parsed = JSON.parse(raw) as Partial<DockPanelLayout<DockPanelSide>>;
        return {
          open: Boolean(parsed.open),
          dock: options.supportedDocks.includes(parsed.dock as TDock)
            ? (parsed.dock as TDock)
            : defaults.dock,
          height: clampSize(parsed.height, options.minHeight, maxHeight(), defaults.height),
          width: clampSize(parsed.width, options.minWidth, maxWidth(), defaults.width),
        };
      } catch {
        return { ...defaults };
      }
    },
    save(layout: DockPanelLayout<TDock>): void {
      try {
        globalThis.localStorage?.setItem(options.storageKey, JSON.stringify(layout));
      } catch {
        // Storage may be unavailable (private mode); layout just won't persist.
      }
    },
  };
}

export const terminalPanelLayout = createDockPanelLayout({
  storageKey: "openclaw.terminal.panel.v1",
  minHeight: 140,
  minWidth: 320,
  defaultDock: "bottom",
  supportedDocks: ["bottom", "right", "main"],
  defaultHeight: 320,
  defaultWidth: 520,
});

export const browserPanelLayout = createDockPanelLayout({
  storageKey: "openclaw.browser.panel.v1",
  minHeight: 240,
  minWidth: 380,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 560,
});

export const assistantPanelLayout = createDockPanelLayout({
  // Shipped key: operators' saved dock size and placement live here, so the
  // legacy custodian spelling stays even though the dock is now shared.
  storageKey: "openclaw.custodian.panel.v1",
  minHeight: 240,
  minWidth: 320,
  defaultDock: "right",
  supportedDocks: ["bottom", "right"],
  defaultHeight: 420,
  defaultWidth: 440,
});
