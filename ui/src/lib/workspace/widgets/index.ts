// Registry of L4 builtin widget renderers, consumed by the widget cell's
// dispatch (ui/src/components/workspace-widget-cell.ts). Keys are the bare kind
// (`builtin:<name>` with the prefix stripped). Adding a builtin = add a module +
// one entry here; the plugin schema's BUILTIN_KIND_PATTERN must list the same
// names (extensions/workspaces/src/schema.ts).

import { renderActivity } from "./activity.ts";
import { renderAgentStatus } from "./agent-status.ts";
import { renderChart } from "./chart.ts";
import { renderCron } from "./cron.ts";
import { renderCustomWidgetApprovals } from "./custom-widget-approvals.ts";
import { renderIframeEmbed } from "./iframe-embed.ts";
import { renderInstances } from "./instances.ts";
import { renderMarkdown } from "./markdown.ts";
import { renderPreview } from "./preview.ts";
import { renderSessions } from "./sessions.ts";
import { renderStatCard } from "./stat-card.ts";
import { renderTable } from "./table.ts";
import type { BuiltinWidgetRenderer } from "./types.ts";
import { renderUsage } from "./usage.ts";

const BUILTIN_WIDGET_RENDERERS: Record<string, BuiltinWidgetRenderer> = {
  "stat-card": (widget, value) => renderStatCard(widget, value),
  markdown: (widget, value) => renderMarkdown(widget, value),
  table: (widget, value) => renderTable(widget, value),
  "iframe-embed": renderIframeEmbed,
  preview: renderPreview,
  sessions: (widget, value, context) => renderSessions(widget, value, context.basePath),
  usage: (widget, value) => renderUsage(widget, value),
  cron: (widget, value) => renderCron(widget, value),
  instances: (widget, value) => renderInstances(widget, value),
  activity: (widget, value) => renderActivity(widget, value),
  chart: (widget, value) => renderChart(widget, value),
  "agent-status": (widget, value) => renderAgentStatus(widget, value),
  "custom-widget-approvals": renderCustomWidgetApprovals,
};

export function getBuiltinRenderer(kind: string): BuiltinWidgetRenderer | undefined {
  const name = kind.startsWith("builtin:") ? kind.slice("builtin:".length) : kind;
  return BUILTIN_WIDGET_RENDERERS[name];
}

export type { BuiltinWidgetContext } from "./types.ts";
