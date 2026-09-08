/**
 * Parser for Docker-style host:container[:options] bind specs.
 */
type SplitBindSpec = {
  host: string;
  container: string;
  options: string;
};

/** Splits a bind spec while preserving Windows drive-letter prefixes in host paths. */
export function splitSandboxBindSpec(
  spec: string,
  options?: { allowWindowsContainerPath?: boolean },
): SplitBindSpec | null {
  const separator = getBindSeparatorIndex(spec);
  if (separator === -1) {
    return null;
  }

  const host = spec.slice(0, separator);
  const rest = spec.slice(separator + 1);
  const optionsStart =
    options?.allowWindowsContainerPath === true ? getBindSeparatorIndex(rest) : rest.indexOf(":");
  if (optionsStart === -1) {
    return { host, container: rest, options: "" };
  }
  return {
    host,
    container: rest.slice(0, optionsStart),
    options: rest.slice(optionsStart + 1),
  };
}

function getBindSeparatorIndex(spec: string): number {
  const hasDriveLetterPrefix = /^[A-Za-z]:[\\/]/.test(spec);
  // A leading drive colon belongs to the path, not the bind separator.
  return spec.indexOf(":", hasDriveLetterPrefix ? 2 : 0);
}
