import { wrapExternalContent } from "../security/external-content.js";

export function wrapUntrustedFileContent(content: string): string {
  return wrapExternalContent(content, {
    source: "unknown",
    includeWarning: false,
  });
}
