// Install output helpers format skill installation results for CLI callers.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

type InstallCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

// Prefer explicit error lines, then the last useful line, to keep CLI failures compact.
function summarizeInstallOutput(text: string): string | undefined {
  const raw = text.trim();
  if (!raw) {
    return undefined;
  }
  const lines = normalizeStringEntries(raw.split("\n"));
  if (lines.length === 0) {
    return undefined;
  }

  const preferred =
    lines.find((line) => /^error\b/i.test(line)) ??
    lines.find((line) => /\b(err!|error:|failed)\b/i.test(line)) ??
    lines.at(-1);

  if (!preferred) {
    return undefined;
  }
  const normalized = preferred.replace(/\s+/g, " ").trim();
  const maxLen = 200;
  return normalized.length > maxLen ? `${truncateUtf16Safe(normalized, maxLen - 1)}…` : normalized;
}

/** Formats a bounded install failure message from command exit and output. */
export function formatInstallFailureMessage(result: InstallCommandResult): string {
  const code = typeof result.code === "number" ? `exit ${result.code}` : "unknown exit";
  const summary = summarizeInstallOutput(result.stderr) ?? summarizeInstallOutput(result.stdout);
  if (!summary) {
    return `Install failed (${code})`;
  }
  return `Install failed (${code}): ${summary}`;
}
