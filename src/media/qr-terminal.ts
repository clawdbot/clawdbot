import { loadQrCodeRuntime, normalizeQrText } from "./qr-runtime.ts";

type QrTerminalModules = {
  data: ArrayLike<boolean | number>;
  size: number;
};

const COMPACT_MARGIN_MODULES = 1;
const TERMINAL_BLACK_ON_WHITE = "\x1b[47m\x1b[30m";
const TERMINAL_RESET = "\x1b[0m";
const FULL_BLOCK = "█";
const UPPER_HALF_BLOCK = "▀";
const LOWER_HALF_BLOCK = "▄";

function readModule(modules: QrTerminalModules, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= modules.size || y >= modules.size) {
    return false;
  }
  return Boolean(modules.data[y * modules.size + x]);
}

function compactBlock(top: boolean, bottom: boolean): string {
  if (top && bottom) {
    return FULL_BLOCK;
  }
  if (top) {
    return UPPER_HALF_BLOCK;
  }
  if (bottom) {
    return LOWER_HALF_BLOCK;
  }
  return " ";
}

function renderCompactTerminalQr(modules: QrTerminalModules): string {
  const lines: string[] = [];
  for (let y = -COMPACT_MARGIN_MODULES; y < modules.size + COMPACT_MARGIN_MODULES; y += 2) {
    let line = TERMINAL_BLACK_ON_WHITE;
    for (let x = -COMPACT_MARGIN_MODULES; x < modules.size + COMPACT_MARGIN_MODULES; x += 1) {
      line += compactBlock(readModule(modules, x, y), readModule(modules, x, y + 1));
    }
    lines.push(`${line}${TERMINAL_RESET}`);
  }
  return lines.join("\n");
}

export async function renderQrTerminal(
  input: string,
  opts: { small?: boolean } = {},
): Promise<string> {
  const text = normalizeQrText(input);
  const qrCode = await loadQrCodeRuntime();
  if (opts.small === true) {
    return renderCompactTerminalQr(qrCode.create(text).modules);
  }
  return await qrCode.toString(text, {
    small: false,
    type: "terminal",
  });
}
