export function escapeSlackMrkdwn(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([*_`~])/g, "\\$1");
}
