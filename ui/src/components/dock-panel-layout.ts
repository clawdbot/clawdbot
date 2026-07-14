export type DockPanelSide = "bottom" | "right";

type DockPanelLayout = {
  open: boolean;
  dock: DockPanelSide;
  height: number;
  width: number;
};

type DockPanelLayoutOptions = {
  storageKey: string;
  minHeight: number;
  minWidth: number;
  defaultDock: DockPanelSide;
  defaultHeight: number;
  defaultWidth: number;
};

export function createDockPanelLayout(options: DockPanelLayoutOptions) {
  const defaults: DockPanelLayout = {
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
    load(): DockPanelLayout {
      try {
        const raw = globalThis.localStorage?.getItem(options.storageKey);
        if (!raw) {
          return { ...defaults };
        }
        const parsed = JSON.parse(raw) as Partial<DockPanelLayout>;
        return {
          open: Boolean(parsed.open),
          dock: parsed.dock === "bottom" || parsed.dock === "right" ? parsed.dock : defaults.dock,
          height: clampSize(parsed.height, options.minHeight, maxHeight(), defaults.height),
          width: clampSize(parsed.width, options.minWidth, maxWidth(), defaults.width),
        };
      } catch {
        return { ...defaults };
      }
    },
    save(layout: DockPanelLayout): void {
      try {
        globalThis.localStorage?.setItem(options.storageKey, JSON.stringify(layout));
      } catch {
        // Storage may be unavailable (private mode); layout just won't persist.
      }
    },
  };
}
