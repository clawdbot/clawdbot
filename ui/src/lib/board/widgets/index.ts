import type { GatewayControlUiPluginWidgetKind } from "../../../api/gateway.ts";
import type { OptionalCustomElement } from "../../../app/lazy-custom-element.ts";
import { t } from "../../../i18n/index.ts";
import type { BoardWidget } from "../types.ts";

type CoreBoardWidgetElement = OptionalCustomElement & {
  kind: string;
  previewSafe: boolean;
};

/**
 * Core renderers register trusted custom elements. Preview-safe elements consume
 * only saved data; they never acquire live subscriptions or invoke Gateway methods.
 */
export const CORE_BOARD_WIDGET_ELEMENTS: readonly CoreBoardWidgetElement[] = [
  {
    kind: "session:progress",
    tagName: "openclaw-session-progress-widget",
    get label() {
      return t("sessionProgressCard.widgetLabel");
    },
    loadModule: () => import("./session-progress.ts"),
    previewSafe: false,
  },
  {
    kind: "session:report",
    tagName: "openclaw-report-widget",
    get label() {
      return t("board.widget.kindReport");
    },
    loadModule: () => import("./report.ts"),
    previewSafe: true,
  },
];

export function pluginIdForWidgetKind(kind: string | undefined): string {
  return kind?.split(":", 1)[0]?.trim() || "unknown";
}

export function getPluginWidgetKindContribution(
  kind: string | undefined,
  activeKinds: readonly GatewayControlUiPluginWidgetKind[],
): CoreBoardWidgetElement | null {
  if (!kind) {
    return null;
  }
  const contribution = CORE_BOARD_WIDGET_ELEMENTS.find((entry) => entry.kind === kind);
  if (!contribution) {
    return null;
  }
  const pluginId = pluginIdForWidgetKind(kind);
  return activeKinds.some((entry) => entry.kind === kind && entry.pluginId === pluginId)
    ? contribution
    : null;
}

export function isPassiveBoardWidget(
  widget: BoardWidget,
  activeKinds: readonly GatewayControlUiPluginWidgetKind[],
): boolean {
  return (
    widget.contentKind === "html" ||
    (widget.contentKind === "plugin" &&
      !widget.frameUrl &&
      getPluginWidgetKindContribution(widget.pluginKind, activeKinds)?.previewSafe === true)
  );
}
