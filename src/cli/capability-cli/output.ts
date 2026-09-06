import { writeRuntimeJson, type RuntimeEnv } from "../../runtime.js";
import type { CapabilityEnvelope } from "./metadata.js";

export function emitJsonOrText<T>(
  runtime: RuntimeEnv,
  json: boolean | undefined,
  value: T,
  textFormatter: (value: T) => string,
) {
  if (json) {
    writeRuntimeJson(runtime, value);
    return;
  }
  runtime.log(textFormatter(value));
}

export function formatEnvelopeForText(envelope: CapabilityEnvelope): string {
  if (!envelope.ok) {
    return `${envelope.capability} failed: ${envelope.error ?? "unknown error"}`;
  }
  const lines = [
    `${envelope.capability} via ${envelope.transport}`,
    ...(envelope.provider ? [`provider: ${envelope.provider}`] : []),
    ...(envelope.model ? [`model: ${envelope.model}`] : []),
    ...(envelope.ignoredOverrides && envelope.ignoredOverrides.length > 0
      ? [`ignoredOverrides: ${JSON.stringify(envelope.ignoredOverrides)}`]
      : []),
    `outputs: ${String(envelope.outputs.length)}`,
  ];
  for (const output of envelope.outputs) {
    const pathValue = typeof output.path === "string" ? output.path : undefined;
    const textValue = typeof output.text === "string" ? output.text : undefined;
    if (pathValue || textValue) {
      lines.push(...[pathValue, textValue].filter((entry): entry is string => Boolean(entry)));
    } else {
      lines.push(JSON.stringify(output));
    }
  }
  return lines.join("\n");
}

export function providerSummaryText(providers: readonly unknown[]): string {
  return providers.map((entry) => JSON.stringify(entry)).join("\n") || "No results found.";
}
