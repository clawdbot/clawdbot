import { escapeRegExp } from "./regexp.mjs";

function formatCommandError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const output = [error.message];
  for (const field of ["stderr", "stdout"]) {
    const value = error[field];
    if (typeof value === "string") {
      output.push(value);
    } else if (Buffer.isBuffer(value)) {
      output.push(value.toString("utf8"));
    }
  }
  return output.join("\n");
}

export function isMissingManifestError(error, imageRef) {
  const message = formatCommandError(error);
  return (
    /(?:manifest unknown|no such manifest)/iu.test(message) ||
    new RegExp(`(?:^|[\\s"'(])${escapeRegExp(imageRef)}:\\s*not found(?:\\s|$)`, "iu").test(message)
  );
}
