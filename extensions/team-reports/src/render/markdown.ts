import type { ReportDocument, SummaryDocument } from "../types.js";
import { countDescription, ITEM_LABELS, memberSummary, safeExternalUrl } from "./shared.js";

function text(value: string): string {
  return value
    .replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ");
}

function modelText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderMarkdown(report: ReportDocument, summary?: SummaryDocument | null): string {
  const lines = [
    `# ${text(report.period.title)}`,
    "",
    `Period: ${report.period.key} (${report.status}). Window: ${new Date(report.period.sinceMs).toISOString()} – ${new Date(report.period.untilMs).toISOString()} (exclusive).`,
    `Generated: ${new Date(report.generatedAtMs).toISOString()}.`,
    "",
    `${report.totals.github.total} GitHub events · ${report.totals.discord.messages} Discord messages · ${report.activeMembers}/${report.memberCount} active members.`,
    "",
  ];
  if (!summary || summary.source === "fallback") {
    lines.push(
      "> Deterministic summary: model summaries are disabled, pending, or unavailable.",
      "",
    );
  }
  if (summary) {
    for (const warning of summary.warnings ?? []) {
      lines.push(`> ${text(warning)}`, "");
    }
    lines.push(
      modelText(summary.globalSummary),
      "",
      "## Highlights",
      "",
      ...summary.highlights.map((highlight) => `- ${text(highlight)}`),
      "",
    );
  }
  const warnings = [...report.sources.github.warnings, ...(report.sources.discord?.warnings ?? [])];
  if (report.truncated) {
    warnings.push("Item lists were truncated; aggregate counts are preserved.");
  }
  if (warnings.length > 0) {
    lines.push("## Coverage", "", ...warnings.map((warning) => `- ${text(warning)}`), "");
  }
  lines.push("## Members", "");
  for (const member of report.members) {
    lines.push(
      `### ${text(member.display)} (@${text(member.login)})`,
      "",
      text(memberSummary(member)),
      "",
      `${countDescription(member.github)} ${member.discord.total} Discord messages.`,
      "",
    );
    for (const item of member.github.items) {
      const url = safeExternalUrl(item.url);
      const title = text(item.title);
      lines.push(
        `- ${ITEM_LABELS[item.kind]} · ${text(item.repo)}: ${url ? `[${title}](<${url}>)` : title}`,
      );
    }
    for (const excerpt of member.discord.excerpts) {
      lines.push(`- Discord #${text(excerpt.channel)}: ${text(excerpt.excerpt)}`);
    }
    lines.push("");
  }
  if (report.otherActors.length > 0) {
    lines.push(
      "## Other GitHub actors",
      "",
      ...report.otherActors.map(
        (actor) => `- @${text(actor.login)}: ${actor.github.total} GitHub events.`,
      ),
      "",
    );
  }
  if (report.unmatchedDiscord.length > 0) {
    lines.push(
      "## Unmatched Discord authors",
      "",
      ...report.unmatchedDiscord.map(
        (author) => `- ${text(author.authorId)}: ${author.messages} messages.`,
      ),
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}
