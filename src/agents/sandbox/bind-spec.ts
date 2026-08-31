/**
 * Parser for Docker-style host:container[:options] bind specs.
 */
type SplitBindSpec = {
  host: string;
  container: string;
  options: string;
};

/** Splits a bind spec while preserving Windows drive-letter prefixes in host paths. */
export function splitSandboxBindSpec(spec: string): SplitBindSpec | null {
  const separator = getHostContainerSeparatorIndex(spec);
  if (separator === -1) {
    return null;
  }

  const host = spec.slice(0, separator);
  const rest = spec.slice(separator + 1);
  const optionsStart = rest.indexOf(":");
  if (optionsStart === -1) {
    return { host, container: rest, options: "" };
  }
  return {
    host,
    container: rest.slice(0, optionsStart),
    options: rest.slice(optionsStart + 1),
  };
}

function getHostContainerSeparatorIndex(spec: string): number {
  const hasDriveLetterPrefix = /^[A-Za-z]:[\\/]/.test(spec);
  // A leading `C:\` or `C:/` colon is part of the host path, not the bind separator.
  for (let i = hasDriveLetterPrefix ? 2 : 0; i < spec.length; i += 1) {
    if (spec[i] === ":") {
      return i;
    }
  }
  return -1;
}
