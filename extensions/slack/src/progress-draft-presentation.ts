import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

function formatSlackProgressDraftLine(line: string): string {
  if (/^(?:🧠|💬)\s/u.test(line)) {
    return line;
  }

  const italicCommentary = /^_(.*)_$/su.exec(line);
  if (!italicCommentary) {
    return escapeSlackMrkdwn(line);
  }

  const content = italicCommentary[1]!
    .split(/(`[^`\n]+`)/u)
    .map((segment, index) => {
      if (index % 2 === 0) {
        return escapeSlackMrkdwn(segment);
      }
      const code = segment
        .slice(1, -1)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      return `\`${code}\``;
    })
    .join("");

  return `_${content}_`;
}

export function createSlackProgressDraftPresentation() {
  return {
    commentaryItalics: true,
    commentaryLinePrefix: "",
    formatLine: formatSlackProgressDraftLine,
    reasoningLinePrefix: "🧠 ",
  } as const;
}
