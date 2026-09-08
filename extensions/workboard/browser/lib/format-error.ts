import { workboardRedact } from "../host.ts";

export function formatUiError(error: unknown, fallback = ""): string {
  return formatUiExternalText(
    error instanceof Error ? error.message : typeof error === "string" ? error : fallback,
    fallback,
  );
}

export function formatUiExternalText(value: string | null | undefined, fallback = ""): string {
  const text = value?.trim();
  return text ? workboardRedact(text) : fallback;
}
