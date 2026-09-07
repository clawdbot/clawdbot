// Browser-safe pattern mechanics; callers retain compilation and masking policy.
export function parseRedactPatternSource(raw: string): [source: string, flags: string] {
  const literal = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!literal) {
    return [raw, "gi"];
  }
  const source = literal[1] ?? "";
  const flags = literal[2] ?? "";
  return [source, flags.includes("g") ? flags : `${flags}g`];
}

export function readRedactMatch(args: unknown[]) {
  const hasNamedGroups =
    args.length > 0 && typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
  const inputIndex = hasNamedGroups ? args.length - 2 : args.length - 1;
  const offsetIndex = inputIndex - 1;
  const match = typeof args[0] === "string" ? args[0] : "";
  const groups = args
    .slice(1, offsetIndex)
    .map((value) => (typeof value === "string" ? value : ""));
  const offset = typeof args[offsetIndex] === "number" ? args[offsetIndex] : -1;
  const input = typeof args[inputIndex] === "string" ? args[inputIndex] : "";
  return { match, groups, input, offset };
}

export type RedactMatch = ReturnType<typeof readRedactMatch>;

export function redactPemBlock(block: string, marker: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n${marker}\n${lines[lines.length - 1]}`;
}
