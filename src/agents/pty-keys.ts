import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { escapeRegExp } from "../utils.js";

const ESC = "\x1b";
const CR = "\r";
const TAB = "\t";
const BACKSPACE = "\x7f";

export const BRACKETED_PASTE_START = `${ESC}[200~`;
export const BRACKETED_PASTE_END = `${ESC}[201~`;

type Modifiers = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
};

/** SS3 sequences for DECCKM application cursor key mode (smkx). */
const DECCKM_SS3_KEYS: Record<string, string> = {
  up: `${ESC}OA`,
  down: `${ESC}OB`,
  right: `${ESC}OC`,
  left: `${ESC}OD`,
  home: `${ESC}OH`,
  end: `${ESC}OF`,
};

const namedKeyMap = new Map<string, string>([
  ["enter", CR],
  ["return", CR],
  ["tab", TAB],
  ["escape", ESC],
  ["esc", ESC],
  ["space", " "],
  ["bspace", BACKSPACE],
  ["backspace", BACKSPACE],
  ["up", `${ESC}[A`],
  ["down", `${ESC}[B`],
  ["right", `${ESC}[C`],
  ["left", `${ESC}[D`],
  ["home", `${ESC}[1~`],
  ["end", `${ESC}[4~`],
  ["pageup", `${ESC}[5~`],
  ["pgup", `${ESC}[5~`],
  ["ppage", `${ESC}[5~`],
  ["pagedown", `${ESC}[6~`],
  ["pgdn", `${ESC}[6~`],
  ["npage", `${ESC}[6~`],
  ["insert", `${ESC}[2~`],
  ["ic", `${ESC}[2~`],
  ["delete", `${ESC}[3~`],
  ["del", `${ESC}[3~`],
  ["dc", `${ESC}[3~`],
  ["btab", `${ESC}[Z`],
  ["f1", `${ESC}OP`],
  ["f2", `${ESC}OQ`],
  ["f3", `${ESC}OR`],
  ["f4", `${ESC}OS`],
  ["f5", `${ESC}[15~`],
  ["f6", `${ESC}[17~`],
  ["f7", `${ESC}[18~`],
  ["f8", `${ESC}[19~`],
  ["f9", `${ESC}[20~`],
  ["f10", `${ESC}[21~`],
  ["f11", `${ESC}[23~`],
  ["f12", `${ESC}[24~`],
  ["kp/", `${ESC}Oo`],
  ["kp*", `${ESC}Oj`],
  ["kp-", `${ESC}Om`],
  ["kp+", `${ESC}Ok`],
  ["kp7", `${ESC}Ow`],
  ["kp8", `${ESC}Ox`],
  ["kp9", `${ESC}Oy`],
  ["kp4", `${ESC}Ot`],
  ["kp5", `${ESC}Ou`],
  ["kp6", `${ESC}Ov`],
  ["kp1", `${ESC}Oq`],
  ["kp2", `${ESC}Or`],
  ["kp3", `${ESC}Os`],
  ["kp0", `${ESC}Op`],
  ["kp.", `${ESC}On`],
  ["kpenter", `${ESC}OM`],
]);

const modifiableNamedKeys = new Set([
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pgup",
  "ppage",
  "pagedown",
  "pgdn",
  "npage",
  "insert",
  "ic",
  "delete",
  "del",
  "dc",
]);

type KeyEncodingRequest = {
  keys?: string[];
  hex?: string[];
  literal?: string;
};

type KeyEncodingResult = {
  data: string;
  warnings: string[];
};

export function hasCursorModeSensitiveKeys(request: KeyEncodingRequest): boolean {
  return (
    request.keys?.some((raw) => {
      const token = raw.trim();
      if (!token) {
        return false;
      }
      const parsed = parseModifiers(token);
      if (hasAnyModifier(parsed.mods)) {
        return false;
      }
      return normalizeLowercaseStringOrEmpty(parsed.base) in DECCKM_SS3_KEYS;
    }) ?? false
  );
}

export function encodeKeySequence(
  request: KeyEncodingRequest,
  cursorKeyMode?: "normal" | "application",
): KeyEncodingResult {
  const warnings: string[] = [];
  let data = "";

  if (request.literal) {
    data += request.literal;
  }

  if (request.hex?.length) {
    for (const raw of request.hex) {
      const byte = parseHexByte(raw);
      if (byte === null) {
        warnings.push(`Invalid hex byte: ${raw}`);
        continue;
      }
      data += String.fromCharCode(byte);
    }
  }

  if (request.keys?.length) {
    for (const token of request.keys) {
      data += encodeKeyToken(token, warnings, cursorKeyMode);
    }
  }

  return { data, warnings };
}

export function encodePaste(text: string, bracketed = true): string {
  if (!bracketed) {
    return text;
  }
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

function encodeKeyToken(
  raw: string,
  warnings: string[],
  cursorKeyMode?: "normal" | "application",
): string {
  const token = raw.trim();
  if (!token) {
    return "";
  }

  if (token.length === 2 && token.startsWith("^")) {
    const ctrl = toCtrlChar(token[1]);
    if (ctrl) {
      return ctrl;
    }
  }

  const parsed = parseModifiers(token);
  const base = parsed.base;
  const baseLower = normalizeLowercaseStringOrEmpty(base);

  if (baseLower === "tab" && parsed.mods.shift) {
    return `${ESC}[Z`;
  }

  // Handle arrow keys specially based on cursor key mode.
  // DECCKM only changes unmodified cursor keys; modified keys use xterm modifier scheme.
  if (
    modifiableNamedKeys.has(baseLower) &&
    cursorKeyMode === "application" &&
    !hasAnyModifier(parsed.mods)
  ) {
    const ss3Seq = DECCKM_SS3_KEYS[baseLower];
    if (ss3Seq) {
      return ss3Seq;
    }
  }

  const baseSeq = namedKeyMap.get(baseLower);
  if (baseSeq) {
    let seq = baseSeq;
    if (modifiableNamedKeys.has(baseLower) && hasAnyModifier(parsed.mods)) {
      const mod = xtermModifier(parsed.mods);
      if (mod > 1) {
        const modified = applyXtermModifier(seq, mod);
        if (modified) {
          seq = modified;
          return seq;
        }
      }
    }
    if (parsed.mods.alt) {
      return `${ESC}${seq}`;
    }
    return seq;
  }

  if (base.length === 1) {
    return applyCharModifiers(base, parsed.mods);
  }

  if (parsed.hasModifiers) {
    warnings.push(`Unknown key "${base}" for modifiers; sending literal.`);
  }
  return base;
}

function parseModifiers(token: string) {
  const mods: Modifiers = { ctrl: false, alt: false, shift: false };
  let rest = token;
  let sawModifiers = false;

  while (rest.length > 2 && rest[1] === "-") {
    const mod = normalizeLowercaseStringOrEmpty(rest[0]);
    if (mod === "c") {
      mods.ctrl = true;
    } else if (mod === "m") {
      mods.alt = true;
    } else if (mod === "s") {
      mods.shift = true;
    } else {
      break;
    }
    sawModifiers = true;
    rest = rest.slice(2);
  }

  return { mods, base: rest, hasModifiers: sawModifiers };
}

function applyCharModifiers(char: string, mods: Modifiers): string {
  let value = char;
  if (mods.shift && value.length === 1 && /[a-z]/.test(value)) {
    value = value.toUpperCase();
  }
  if (mods.ctrl) {
    const ctrl = toCtrlChar(value);
    if (ctrl) {
      value = ctrl;
    }
  }
  if (mods.alt) {
    value = `${ESC}${value}`;
  }
  return value;
}

function toCtrlChar(char: string): string | null {
  if (char.length !== 1) {
    return null;
  }
  if (char === "?") {
    return "\x7f";
  }
  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) {
    return String.fromCharCode(code & 0x1f);
  }
  return null;
}

function xtermModifier(mods: Modifiers): number {
  let mod = 1;
  if (mods.shift) {
    mod += 1;
  }
  if (mods.alt) {
    mod += 2;
  }
  if (mods.ctrl) {
    mod += 4;
  }
  return mod;
}

function applyXtermModifier(sequence: string, modifier: number): string | null {
  const escPattern = escapeRegExp(ESC);
  const csiNumber = new RegExp(`^${escPattern}\\[(\\d+)([~A-Z])$`);
  const csiArrow = new RegExp(`^${escPattern}\\[(A|B|C|D|H|F)$`);

  const numberMatch = sequence.match(csiNumber);
  if (numberMatch) {
    return `${ESC}[${numberMatch[1]};${modifier}${numberMatch[2]}`;
  }

  const arrowMatch = sequence.match(csiArrow);
  if (arrowMatch) {
    return `${ESC}[1;${modifier}${arrowMatch[1]}`;
  }

  return null;
}

function hasAnyModifier(mods: Modifiers): boolean {
  return mods.ctrl || mods.alt || mods.shift;
}

function parseHexByte(raw: string): number | null {
  const lower = normalizeLowercaseStringOrEmpty(raw);
  const normalized = lower.startsWith("0x") ? lower.slice(2) : lower;
  if (!/^[0-9a-f]{1,2}$/.test(normalized)) {
    return null;
  }
  const value = Number.parseInt(normalized, 16);
  if (Number.isNaN(value) || value < 0 || value > 0xff) {
    return null;
  }
  return value;
}
