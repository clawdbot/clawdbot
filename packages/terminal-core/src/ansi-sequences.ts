export const ANSI_OSC_INTRODUCER_PATTERN = "(?:\\x1b\\]|\\x9d)";
export const ANSI_STRING_TERMINATOR_PATTERN = "(?:\\x1b\\\\|\\x07|\\x9c)";
const ANSI_OSC_PATTERN = `${ANSI_OSC_INTRODUCER_PATTERN}[^\\x07\\x1b\\x9c]*${ANSI_STRING_TERMINATOR_PATTERN}`;

const ansiOscAtIndexRegex = new RegExp(ANSI_OSC_PATTERN, "y");

export type AnsiSegment =
  | { controls: string[]; kind: "ansi"; value: string }
  | { kind: "text"; value: string };

export function matchAnsiOscAt(input: string, index: number): string | undefined {
  ansiOscAtIndexRegex.lastIndex = index;
  return ansiOscAtIndexRegex.exec(input)?.[0];
}

function csiIntroducerLength(input: string, index: number): number {
  const code = input.charCodeAt(index);
  if (code === 0x9b) {
    return 1;
  }
  return code === 0x1b && input.charCodeAt(index + 1) === 0x5b ? 2 : 0;
}

export type AnsiCsiScan = {
  controls: string[];
  ended: boolean;
  value: string;
};

/** Scan one CSI parser pass, retaining independently executed C0 controls. */
export function scanAnsiCsiAt(input: string, index: number): AnsiCsiScan | undefined {
  const introducerLength = csiIntroducerLength(input, index);
  if (introducerLength === 0) {
    return undefined;
  }

  let cursor = index + introducerLength;
  const controls: string[] = [];
  let ended = false;
  while (cursor < input.length) {
    const code = input.charCodeAt(cursor);
    if (code === 0x18 || code === 0x1a) {
      cursor += 1;
      ended = true;
      break;
    }
    if (code === 0x1b || code === 0x9b) {
      ended = true;
      break;
    }
    if (code <= 0x1f || code === 0x7f) {
      controls.push(input.charAt(cursor));
      cursor += 1;
      continue;
    }
    if (code >= 0x20 && code <= 0x3f) {
      cursor += 1;
      continue;
    }
    if (code >= 0x40 && code <= 0x7e) {
      cursor += 1;
    }
    ended = true;
    break;
  }
  return { controls, ended, value: input.slice(index, cursor) };
}

export function splitAnsiSegments(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let position = 0;
  let index = 0;

  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code !== 0x1b && code !== 0x9b && code !== 0x9d) {
      index += 1;
      continue;
    }

    const osc = matchAnsiOscAt(input, index);
    const csi = osc ? undefined : scanAnsiCsiAt(input, index);
    const value = osc ?? csi?.value;
    if (!value) {
      index += 1;
      continue;
    }
    if (index > position) {
      segments.push({ kind: "text", value: input.slice(position, index) });
    }
    segments.push({ controls: csi?.controls ?? [], kind: "ansi", value });
    index += value.length;
    position = index;
  }
  if (position < input.length) {
    segments.push({ kind: "text", value: input.slice(position) });
  }
  return segments;
}
