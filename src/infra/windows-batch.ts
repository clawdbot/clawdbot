import path from "node:path";

export function normalizeNewWindowsBatchContent(filePath: string, content: string): string {
  if (![".bat", ".cmd"].includes(path.extname(filePath).toLowerCase())) {
    return content;
  }
  return content.replace(/\r\n|\r|\n/g, "\r\n");
}
