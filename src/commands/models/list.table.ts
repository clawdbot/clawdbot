import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { sanitizeTerminalText } from "../../terminal/safe-text.js";
import { colorize, theme } from "../../terminal/theme.js";
import { formatTag, isRich, pad, truncate } from "./list.format.js";
import type { ModelRow } from "./list.types.js";
import { formatTokenK } from "./shared.js";

const MODEL_PAD = 42;
const INPUT_PAD = 10;
const CTX_PAD = 8;
const LOCAL_PAD = 5;
const AUTH_PAD = 5;

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
    pad("Model", MODEL_PAD),
    pad("Input", INPUT_PAD),
    pad("Ctx", CTX_PAD),
    pad("Local", LOCAL_PAD),
    pad("Auth", AUTH_PAD),
    "Tags",
  ].join(" ");
  runtime.log(rich ? theme.heading(header) : header);

  for (const row of rows) {
    const keyLabel = pad(truncate(sanitizeTerminalText(row.key), MODEL_PAD), MODEL_PAD);
    const inputLabel = pad(sanitizeTerminalText(row.input) || "-", INPUT_PAD);
    const ctxLabel = pad(formatTokenK(row.contextWindow), CTX_PAD);
    const localText = row.local === null ? "-" : row.local ? "yes" : "no";
    const localLabel = pad(localText, LOCAL_PAD);
    const authText = row.available === null ? "-" : row.available ? "yes" : "no";
    const authLabel = pad(authText, AUTH_PAD);
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
