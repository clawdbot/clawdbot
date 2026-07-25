export type DockPanelSide = "bottom" | "left" | "right";

type DockPanelLayout<TDock extends DockPanelSide> = {
  open: boolean;
  dock: TDock;
  height: number;
  width: number;
};

type DockPanelLayoutOptions<TDock extends DockPanelSide> = {
  storageKey: string;
  minHeight: number;
  minWidth: number;
  defaultDock: TDock;
  supportedDocks: readonly TDock[];
  defaultHeight: number;
  defaultWidth: number;
};

export function createDockPanelLayout<TDock extends DockPanelSide>(
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
