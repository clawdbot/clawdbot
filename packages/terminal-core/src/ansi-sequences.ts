export const ANSI_OSC_INTRODUCER_PATTERN = "(?:\\x1b\\]|\\x9d)";
export const ANSI_STRING_TERMINATOR_PATTERN = "(?:\\x1b\\\\|\\x07|\\x9c)";
const ANSI_OSC_PATTERN = `${ANSI_OSC_INTRODUCER_PATTERN}[^\\x07\\x1b\\x9c]*${ANSI_STRING_TERMINATOR_PATTERN}`;
export const ANSI_COMPAT_CONTROL_SEQUENCE_PATTERN =
  "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";

const ansiOscAtIndexRegex = new RegExp(ANSI_OSC_PATTERN, "y");

type AnsiSegment =
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

type AnsiCsiScan = {
  controls: string[];
  ended: boolean;
  value: string;
};

type AnsiStripState = "text" | "escape" | "osc" | "osc-escape" | "csi" | "compat";

function isCompatPrefixCode(code: number): boolean {
  return (
    code === 0x5b ||
    code === 0x5d ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x23 ||
    code === 0x3b ||
    code === 0x3f
  );
}

function isCompatParameterCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || code === 0x3a || code === 0x3b;
}

function isDigitCode(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isCompatFinalCode(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x40 && code <= 0x5a) ||
    code === 0x63 ||
    (code >= 0x66 && code <= 0x6e) ||
    (code >= 0x71 && code <= 0x75) ||
    code === 0x79 ||
    code === 0x3d ||
    code === 0x3e ||
    code === 0x3c ||
    code === 0x7e
  );
}

/**
 * Incrementally strip the ANSI grammar accepted by the agent output sanitizer.
 * Parser state stays constant-size so unterminated OSC payloads cannot escape
 * or accumulate outside the caller's output limits.
 */
export class AnsiSequenceStripper {
  private state: AnsiStripState = "text";
  private csiCompatPrefixOnly = false;
  private compatInParameters = false;
  private compatParameterDigits = 0;

  write(input: string): string {
    if (typeof input !== "string") {
      throw new TypeError(`Expected a \`string\`, got \`${typeof input}\``);
    }
    if (
      this.state === "text" &&
      !input.includes("\u001B") &&
      !input.includes("\u009B") &&
      !input.includes("\u009D")
    ) {
      return input;
    }

    const output: string[] = [];
    let index = 0;
    while (index < input.length) {
      const code = input.charCodeAt(index);

      if (this.state === "text") {
        if (code === 0x1b) {
          this.state = "escape";
        } else if (code === 0x9b) {
          this.state = "csi";
          this.csiCompatPrefixOnly = true;
        } else if (code === 0x9d) {
          this.state = "osc";
        } else {
          output.push(input.charAt(index));
        }
        index += 1;
        continue;
      }

      if (this.state === "osc") {
        if (code === 0x07 || code === 0x9c) {
          this.state = "text";
        } else if (code === 0x1b) {
          this.state = "osc-escape";
        }
        index += 1;
        continue;
      }

      if (this.state === "osc-escape") {
        if (code === 0x5c || code === 0x07 || code === 0x9c) {
          this.state = "text";
        } else if (code !== 0x1b) {
          this.state = "osc";
        }
        index += 1;
        continue;
      }

      if (this.state === "csi") {
        if (code === 0x18 || code === 0x1a) {
          this.state = "text";
          index += 1;
        } else if (code === 0x1b) {
          this.state = "escape";
          index += 1;
        } else if (code === 0x9b) {
          this.csiCompatPrefixOnly = true;
          index += 1;
        } else if (code === 0x9d) {
          this.state = "osc";
          index += 1;
        } else if (code <= 0x1f || code === 0x7f) {
          output.push(input.charAt(index));
          index += 1;
        } else if (code >= 0x20 && code <= 0x3f) {
          if (!isCompatPrefixCode(code)) {
            this.csiCompatPrefixOnly = false;
          }
          index += 1;
        } else if ((code === 0x5b || code === 0x5d) && this.csiCompatPrefixOnly) {
          // The compatibility grammar accepts bracket runs before parameters.
          // Keep them pending so a chunk split cannot expose the final byte.
          this.state = "compat";
          this.compatInParameters = false;
          this.compatParameterDigits = 0;
          index += 1;
        } else if (code >= 0x40 && code <= 0x7e) {
          this.state = "text";
          index += 1;
        } else {
          this.state = "text";
        }
        continue;
      }

      if (this.state === "escape") {
        if (code === 0x5d) {
          this.state = "osc";
          index += 1;
        } else if (code === 0x5b) {
          this.state = "csi";
          this.csiCompatPrefixOnly = true;
          index += 1;
        } else if (code === 0x1b) {
          index += 1;
        } else if (code === 0x9b) {
          this.state = "csi";
          this.csiCompatPrefixOnly = true;
          index += 1;
        } else if (code === 0x9d) {
          this.state = "osc";
          index += 1;
        } else if (isCompatPrefixCode(code)) {
          this.state = "compat";
          this.compatInParameters = false;
          this.compatParameterDigits = 0;
          index += 1;
        } else if (isDigitCode(code)) {
          this.state = "compat";
          this.compatInParameters = true;
          this.compatParameterDigits = 1;
          index += 1;
        } else if (isCompatFinalCode(code)) {
          this.state = "text";
          index += 1;
        } else {
          this.state = "text";
        }
        continue;
      }

      if (code === 0x18 || code === 0x1a) {
        this.state = "text";
        index += 1;
      } else if (code === 0x1b) {
        this.state = "escape";
        index += 1;
      } else if (code === 0x9b) {
        this.state = "csi";
        this.csiCompatPrefixOnly = true;
        index += 1;
      } else if (code === 0x9d) {
        this.state = "osc";
        index += 1;
      } else if (!this.compatInParameters && isCompatPrefixCode(code)) {
        index += 1;
      } else if (!this.compatInParameters && isDigitCode(code)) {
        this.compatInParameters = true;
        this.compatParameterDigits = 1;
        index += 1;
      } else if (this.compatInParameters && isCompatParameterCode(code)) {
        if (code === 0x3a || code === 0x3b) {
          this.compatParameterDigits = 0;
          index += 1;
        } else if (this.compatParameterDigits < 4) {
          this.compatParameterDigits += 1;
          index += 1;
        } else {
          this.state = "text";
          index += 1;
        }
      } else if (isCompatFinalCode(code)) {
        this.state = "text";
        index += 1;
      } else {
        this.state = "text";
      }
    }
    return output.join("");
  }

  finish(): string {
    this.state = "text";
    this.csiCompatPrefixOnly = false;
    this.compatInParameters = false;
    this.compatParameterDigits = 0;
    return "";
  }
}

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
