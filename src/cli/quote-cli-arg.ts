export function quotePowerShellArg(value: string): string {
  // PowerShell recognizes typographic single quotes as delimiters too.
  return `'${value.replace(/['‘-‛]/gu, "$&$&")}'`;
}

export function quoteCliArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
