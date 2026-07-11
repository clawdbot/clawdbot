// Contract for the L4 builtin widget library. Each builtin is a pure render
// function keyed by its kind (`builtin:<name>`); the widget cell dispatches
// through the registry (`./index.ts`). Data-shape mapping lives in exported,
// separately-unit-tested `map*` helpers per widget so the RPC payload → view
// model transform is verifiable without a DOM.
//
// Renderers NEVER fetch: they receive the already-resolved primary binding
// value (the L3 view resolves the first declared binding on the page's gateway
// client) plus the widget's `props`. A binding error is surfaced by the cell's
// error boundary before a renderer runs, so renderers only see values.

import type { TemplateResult } from "lit";
import type { ApplicationConfigCapability } from "../../../app/config.ts";
import type { WorkspaceWidget } from "../types.ts";

/** Ambient context a builtin may need beyond its own binding value. */
export type BuiltinWidgetContext = {
  /** Control UI mount path used by builtins that link to another app route. */
  basePath: string;
  /** Control UI embed policy — only the iframe-embed widget consumes it. */
  embed: Pick<
    ApplicationConfigCapability["current"],
    "embedSandboxMode" | "allowExternalEmbedUrls"
  >;
};

/** A builtin widget renderer: pure, side-effect-free, throws only on real bugs. */
export type BuiltinWidgetRenderer = (
  widget: WorkspaceWidget,
  value: unknown,
  ctx: BuiltinWidgetContext,
) => TemplateResult;

export function widgetProps(widget: WorkspaceWidget): Record<string, unknown> {
  return widget.props ?? {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce a possibly-string numeric field to a finite number, else undefined. */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
