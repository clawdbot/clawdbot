/**
 * A payload stamped `preRendered: "slack-mrkdwn"` skips the markdown pass: the
 * writer typed Slack mrkdwn (one star for bold, `<url|label>` links), and the
 * pass would turn `*subject*` into `_subject_`. The pass also escaped `&`, `<`
 * and `>` for the writer; the bypass does that itself, outside Slack's own
 * control tokens, because text such as a traceback's `in <module>` would
 * otherwise be read by Slack as a token and dropped.
 */

/** `<url|label>`, `<url>`, `<@user>`, `<#channel|name>`, `<!here>`: Slack's tokens, kept as written. */
const SLACK_CONTROL_TOKEN_RE = /<(?:https?:\/\/[^>]*|[@#!][^>]*)>/g;
/** An entity the writer already wrote stays as it is. */
const SLACK_ENTITY_RE = /&(?!amp;|lt;|gt;)/g;

function escapeSegment(segment: string): string {
  return segment.replace(SLACK_ENTITY_RE, "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeSlackReservedKeepingLinks(text: string): string {
  const out: string[] = [];
  let last = 0;
  for (const match of text.matchAll(SLACK_CONTROL_TOKEN_RE)) {
    out.push(escapeSegment(text.slice(last, match.index)), match[0]);
    last = match.index + match[0].length;
  }
  out.push(escapeSegment(text.slice(last)));
  return out.join("");
}

/** A payload pre-rendered for another channel is not Slack's to interpret. */
export function readSlackPreRenderedText(formatting?: { preRendered?: string }): boolean {
  return formatting?.preRendered === "slack-mrkdwn";
}

/** The text the bypass sends: escaped when pre-rendered, untouched otherwise. */
export function slackPreRenderedText(text: string, formatting?: { preRendered?: string }): string {
  return readSlackPreRenderedText(formatting) ? escapeSlackReservedKeepingLinks(text) : text;
}
