/**
 * Rendering helpers for exec output/status updates.
 * Keeps no-output placeholders and warning placement consistent across exec
 * progress, polling, and completion surfaces.
 */
const EXEC_NO_OUTPUT_PLACEHOLDER = "(no output)";

/** Render command output with a stable placeholder for empty output. */
export function renderExecOutputText(value: string | undefined): string {
  return value || EXEC_NO_OUTPUT_PLACEHOLDER;
}

/** Render the text shown in exec progress updates, including warnings first. */
export function renderExecUpdateText(params: { tailText?: string; warnings: string[] }): string {
  const warningText = params.warnings.length ? `${params.warnings.join("\n")}\n\n` : "";
  return warningText + renderExecOutputText(params.tailText);
}
