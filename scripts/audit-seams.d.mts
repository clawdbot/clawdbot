#!/usr/bin/env node
export function describeSeamKinds(relativePath: unknown, source: unknown): string[];
export function determineSeamTestStatus(
  seamKinds: unknown,
  relatedTestMatches: unknown,
): {
  status: string;
  reason: string;
};
export function main(argv?: string[]): Promise<void>;
export const HELP_TEXT: "Usage: node scripts/audit-seams.mjs [--help]\n\nAudit repo seam inventory and emit JSON to stdout.\n\nSections:\n  duplicatedSeamFamilies       Plugin SDK seam families imported from multiple production files\n  overlapFiles                 Production files that touch multiple seam families\n  optionalClusterStaticLeaks   Optional extension/plugin clusters referenced from the static graph\n  missingPackages              Workspace packages whose deps are not mirrored at the root\n  seamTestInventory            High-signal seam candidates with nearby-test gap signals,\n                               including cron orchestration seams for agent handoff,\n                               outbound/media delivery, heartbeat/followup handoff,\n                               and scheduler state crossings, plus subagent seams\n                               for spawn/session handoff, announce delivery,\n                               lifecycle registry, cleanup, and parent streaming\n\nNotes:\n  - Output is JSON only.\n  - For clean redirected JSON through package scripts, prefer:\n      pnpm --silent audit:seams > seam-inventory.json\n";
