/** Terminal/JSON/plain table renderer for model-list rows. */
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { colorize, theme } from "../../../packages/terminal-core/src/theme.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { formatTag, formatTokenK, isRich, padTerminalCell, truncate } from "./list.format.js";
import type { ModelRow } from "./list.types.js";

const MODEL_PAD = 42;
const INPUT_PAD = 10;
const CTX_PAD = 11;
const LOCAL_PAD = 5;
const AUTH_PAD = 5;

function formatContextLabel(row: ModelRow): string {
  if (
    typeof row.contextTokens === "number" &&
    Number.isFinite(row.contextTokens) &&
    row.contextTokens > 0 &&
    row.contextTokens !== row.contextWindow
  ) {
    return `${formatTokenK(row.contextTokens)}/${formatTokenK(row.contextWindow)}`;
  }
  return formatTokenK(row.contextWindow);
}

/** Prints model-list rows in JSON, plain, or fixed-width terminal form. */
export function printModelTable(
  rows: ModelRow[],
  runtime: RuntimeEnv,
  opts: { json?: boolean; plain?: boolean } = {},
) {
  if (opts.json) {
    writeRuntimeJson(runtime, {
      count: rows.length,
      models: rows,
    });
    return;
  }

  if (opts.plain) {
    for (const row of rows) {
      runtime.log(sanitizeTerminalText(row.key));
    }
    return;
  }

  const rich = isRich(opts);
  const header = [
    padTerminalCell("Model", MODEL_PAD),
    padTerminalCell("Input", INPUT_PAD),
    padTerminalCell("Ctx", CTX_PAD),
    padTerminalCell("Local", LOCAL_PAD),
    padTerminalCell("Auth", AUTH_PAD),
    "Tags",
  ].join(" ");
  runtime.log(rich ? theme.heading(header) : header);

  for (const row of rows) {
    const keyLabel = padTerminalCell(truncate(sanitizeTerminalText(row.key), MODEL_PAD), MODEL_PAD);
    const inputLabel = padTerminalCell(sanitizeTerminalText(row.input) || "-", INPUT_PAD);
    const ctxLabel = padTerminalCell(formatContextLabel(row), CTX_PAD);
    const localText = row.local === null ? "-" : row.local ? "yes" : "no";
    const localLabel = padTerminalCell(localText, LOCAL_PAD);
    const authText = row.available === null ? "-" : row.available ? "yes" : "no";
    const authLabel = padTerminalCell(authText, AUTH_PAD);
    const tags = row.tags.map(sanitizeTerminalText);
    const tagsLabel =
      tags.length > 0
        ? rich
          ? tags.map((tag) => formatTag(tag, rich)).join(",")
          : tags.join(",")
        : "";

    const coloredInput = colorize(
      rich,
      row.input.includes("image") ? theme.accentBright : theme.info,
      inputLabel,
    );
    const coloredLocal = colorize(
      rich,
      row.local === null ? theme.muted : row.local ? theme.success : theme.muted,
      localLabel,
    );
    const coloredAuth = colorize(
      rich,
      row.available === null ? theme.muted : row.available ? theme.success : theme.error,
      authLabel,
    );

    const line = [
      rich ? theme.accent(keyLabel) : keyLabel,
      coloredInput,
      ctxLabel,
      coloredLocal,
      coloredAuth,
      tagsLabel,
    ].join(" ");
    runtime.log(line);
  }
}
