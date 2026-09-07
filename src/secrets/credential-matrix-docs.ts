import type { SecretRefCredentialMatrixDocument } from "./credential-matrix.js";

const SUPPORTED_START = '[//]: # "secretref-supported-list-start"';
const SUPPORTED_END = '[//]: # "secretref-supported-list-end"';
const UNSUPPORTED_START = '[//]: # "secretref-unsupported-list-start"';
const UNSUPPORTED_END = '[//]: # "secretref-unsupported-list-end"';

function replaceMarkedBlock(params: {
  source: string;
  startMarker: string;
  endMarker: string;
  lines: string[];
}): string {
  const indexes = (marker: string): number[] => {
    const found: number[] = [];
    for (let offset = 0; ;) {
      const index = params.source.indexOf(marker, offset);
      if (index < 0) {
        return found;
      }
      found.push(index);
      offset = index + marker.length;
    }
  };
  const startIndexes = indexes(params.startMarker);
  const endIndexes = indexes(params.endMarker);
  if (startIndexes.length !== 1 || endIndexes.length !== 1) {
    throw new Error(
      `SecretRef docs marker count invalid for ${params.startMarker}: expected one start and one end`,
    );
  }
  const startIndex = startIndexes[0];
  const endIndex = endIndexes[0];
  if (startIndex === undefined || endIndex === undefined || endIndex <= startIndex) {
    throw new Error(`SecretRef docs marker order invalid for ${params.startMarker}`);
  }

  return [
    params.source.slice(0, startIndex + params.startMarker.length),
    "\n\n",
    params.lines.join("\n"),
    "\n\n",
    params.source.slice(endIndex),
  ].join("");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted((a, b) => a.localeCompare(b));
}

function formatSupportedLines(matrix: SecretRefCredentialMatrixDocument): string[] {
  const openclawPaths = uniqueSorted(
    matrix.entries
      .filter((entry) => entry.configFile === "openclaw.json")
      .map((entry) => entry.path),
  );
  const authProfileLines = matrix.entries
    .filter((entry) => entry.configFile === "auth-profile-store")
    .toSorted((a, b) => (a.refPath ?? a.path).localeCompare(b.refPath ?? b.path))
    .map((entry) => {
      const path = entry.refPath ?? entry.path;
      const condition = entry.when
        ? ` (\`type: "${entry.when.type}"\`; unsupported when \`auth.profiles.<id>.mode = "oauth"\`)`
        : "";
      return `- \`${path}\`${condition}`;
    });

  const lines = openclawPaths.map((path) => `- \`${path}\``);
  if (authProfileLines.length > 0) {
    lines.push(
      "",
      "### SQLite auth-profile targets (`secrets configure` + `secrets apply` + `secrets audit`)",
      "",
      ...authProfileLines,
    );
  }
  return lines;
}

export function renderSecretRefCredentialMatrixJson(
  matrix: SecretRefCredentialMatrixDocument,
): string {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

export function renderSecretRefCredentialSurface(
  currentSurface: string,
  matrix: SecretRefCredentialMatrixDocument,
): string {
  const normalized = currentSurface.replace(/\r\n?/g, "\n");
  const withSupported = replaceMarkedBlock({
    source: normalized,
    startMarker: SUPPORTED_START,
    endMarker: SUPPORTED_END,
    lines: formatSupportedLines(matrix),
  });
  return replaceMarkedBlock({
    source: withSupported,
    startMarker: UNSUPPORTED_START,
    endMarker: UNSUPPORTED_END,
    lines: uniqueSorted(matrix.excludedMutableOrRuntimeManaged).map((path) => `- \`${path}\``),
  });
}
