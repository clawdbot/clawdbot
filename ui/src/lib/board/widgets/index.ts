import type { TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { renderSwarmWidget } from "./swarm.ts";

type BuiltinBoardWidgetRenderer = (context: {
  sessions: readonly GatewaySessionRow[];
  sessionKey: string;
}) => TemplateResult;

const BUILTIN_WIDGET_RENDERERS: Record<string, BuiltinBoardWidgetRenderer> = {
  swarm: renderSwarmWidget,
};

export function getBuiltinWidgetRenderer(
  name: string | undefined,
): BuiltinBoardWidgetRenderer | null {
  return name ? (BUILTIN_WIDGET_RENDERERS[name] ?? null) : null;
}
