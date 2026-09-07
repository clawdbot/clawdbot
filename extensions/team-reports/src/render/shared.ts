import type { GithubCounts, GithubItemKind, PersonReport } from "../types.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function renderAvatar(
  login: string,
  display: string,
  size: "xs" | "sm" | "md" | "xl",
): string {
  const words = (display.trim() || login).split(/\s+/);
  const initials = (
    words.length > 1
      ? `${Array.from(words[0] ?? "")[0] ?? ""}${Array.from(words.at(-1) ?? "")[0] ?? ""}`
      : Array.from(words[0] ?? "")
          .slice(0, 2)
          .join("")
  ).toUpperCase();
  const pixels = { xs: 20, sm: 36, md: 40, xl: 72 }[size];
  const image = /^[A-Za-z0-9-]{1,39}$/.test(login)
    ? `<img src="https://avatars.githubusercontent.com/${escapeHtml(login)}?s=${pixels}" width="${pixels}" height="${pixels}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
    : "";
  return `<span class="oc-avatar oc-avatar-${size}" data-initials="${escapeHtml(initials)}">${image}</span>`;
}

export function safeExternalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const ITEM_LABELS: Record<GithubItemKind, string> = {
  commit: "Commit",
  pr_opened: "PR opened",
  pr_merged: "PR merged",
  pr_closed: "PR closed",
  issue_opened: "Issue opened",
  issue_closed: "Issue closed",
  issue_comment: "Issue comment",
  review_comment: "Review comment",
  security_advisory: "Security advisory",
};

export function countDescription(counts: GithubCounts): string {
  const entries: Array<[number, string]> = [
    [counts.commits, "commits"],
    [counts.prsOpened, "PRs opened"],
    [counts.prsMerged, "PRs merged"],
    [counts.prsClosed, "PRs closed"],
    [counts.issuesOpened, "issues opened"],
    [counts.issuesClosed, "issues closed"],
    [counts.issueComments, "issue comments"],
    [counts.reviewComments, "review comments"],
    [counts.securityAdvisories, "security advisories"],
  ];
  return (
    entries
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(" · ") || "No GitHub activity recorded."
  );
}

export function memberSummary(member: PersonReport): string {
  return (
    member.summary?.text ??
    (member.github.total + member.discord.total === 0
      ? "No GitHub activity or Discord messages recorded in this period."
      : `${member.github.total} GitHub events and ${member.discord.total} Discord messages recorded in this period.`)
  );
}
