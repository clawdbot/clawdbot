export function sshArgvPort(argv: readonly string[]): number | undefined {
  if (argv[0] !== "ssh") {
    return undefined;
  }
  return Number(argv[argv.indexOf("-p") + 1]);
}

export function rsyncArgvPort(argv: readonly string[]): number | undefined {
  if (argv[0] !== "rsync") {
    return undefined;
  }
  const remoteShell = argv[argv.indexOf("-e") + 1] ?? "";
  const match = /'-p' '(\d+)'/u.exec(remoteShell);
  return match ? Number(match[1]) : undefined;
}
