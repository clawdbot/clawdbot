import type { TemplateResult } from "lit";
import type { GatewayControlUiPluginWidgetKind } from "../../../api/gateway.ts";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import type { BoardViewWidget } from "../view-types.ts";
import { renderSwarmWidget } from "./swarm.ts";

type BuiltinBoardWidgetRenderer = (context: {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
}) => TemplateResult;

export type PluginBoardWidgetRenderer = (props: {
  widget: BoardViewWidget;
  sessionKey: string;
  requestUpdate: () => void;
}) => TemplateResult;

type PluginWidgetKindContribution = {
  kind: string;
  label: string;
  loader: () => Promise<PluginBoardWidgetRenderer>;
};

/**
 * Plugin renderers are trusted first-party Control UI code. They render in the
 * cell without an iframe or grants, receive only widget/session/update props,
 * and use the standard gateway client for RPCs owned by their plugin.
 */
const PLUGIN_WIDGET_KIND_CONTRIBUTIONS: Record<string, PluginWidgetKindContribution> = {
  "workboard:card": {
    kind: "workboard:card",
    label: t("workboard.widget.cardLabel"),
    loader: async () => (await import("./workboard-card.ts")).renderWorkboardCardWidget,
  },
  "workboard:mini": {
    kind: "workboard:mini",
    label: t("workboard.widget.summaryLabel"),
    loader: async () => (await import("./workboard-mini.ts")).renderWorkboardMiniWidget,
  },
};

const pluginRendererPromises = new Map<string, Promise<PluginBoardWidgetRenderer>>();

const BUILTIN_WIDGET_RENDERERS: Record<string, BuiltinBoardWidgetRenderer> = {
  swarm: renderSwarmWidget,
};

export function getBuiltinWidgetRenderer(
  name: string | undefined,
): BuiltinBoardWidgetRenderer | null {
  return name ? (BUILTIN_WIDGET_RENDERERS[name] ?? null) : null;
}

export function pluginIdForWidgetKind(kind: string | undefined): string {
  return kind?.split(":", 1)[0]?.trim() || "unknown";
}

export function getPluginWidgetKindContribution(
  kind: string | undefined,
  activeKinds: readonly GatewayControlUiPluginWidgetKind[],
): PluginWidgetKindContribution | null {
  if (!kind) {
    return null;
  }
  const contribution = PLUGIN_WIDGET_KIND_CONTRIBUTIONS[kind];
  if (!contribution) {
    return null;
  }
  const pluginId = pluginIdForWidgetKind(kind);
  return activeKinds.some((entry) => entry.kind === kind && entry.pluginId === pluginId)
    ? contribution
    : null;
}

export function loadPluginWidgetRenderer(
  contribution: PluginWidgetKindContribution,
): Promise<PluginBoardWidgetRenderer> {
  const existing = pluginRendererPromises.get(contribution.kind);
  if (existing) {
    return existing;
  }
  const loaded = contribution.loader();
  pluginRendererPromises.set(contribution.kind, loaded);
  void loaded.catch(() => {
    if (pluginRendererPromises.get(contribution.kind) === loaded) {
      pluginRendererPromises.delete(contribution.kind);
    }
  });
  return loaded;
}
