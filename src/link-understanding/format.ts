// Link-understanding formatter appends normalized fetched-link summaries to the agent-visible message body.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";

/** Appends normalized link-understanding outputs to the agent-visible body. */
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
