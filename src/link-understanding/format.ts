import { normalizeStringEntries } from "../shared/string-normalization.js";

export function formatLinkUnderstandingBody(params: { body?: string; outputs: string[] }): string {
  const outputs = normalizeStringEntries(params.outputs);
  if (outputs.length === 0) {
    return params.body ?? "";
  }

  const base = (params.body ?? "").trim();
  if (!base) {
    return outputs.join("\n");
  }
  return `${base}\n\n${outputs.join("\n")}`;
}
