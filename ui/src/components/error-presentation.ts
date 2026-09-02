const ERROR_ICON_PREFIX_TOKEN_RE = /(?:⚠️?|⛔|❌|🛠️?|✉️?)/gu;
const ERROR_ICON_PREFIX_RE = /^[ \t]*(?:⚠️?|⛔|❌|🛠️?|✉️?)(?:[ \t]*(?:⚠️?|⛔|❌|🛠️?|✉️?))*/u;

// Icon-backed error cards and rows replace these leading decoration/category glyphs.
// Keep all whitespace and body emoji intact; raw state, copy, transcript, and toasts bypass this.
export function formatWebUiIconErrorText(error: string): string {
  return error.replace(ERROR_ICON_PREFIX_RE, (prefix) =>
    prefix.replace(ERROR_ICON_PREFIX_TOKEN_RE, ""),
  );
}
