import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePngRgba(buffer: Buffer, width: number, height: number) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0; // filter: none
    buffer.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }
  const compressed = deflateSync(raw);

  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function fillPixel(
  buf: Buffer,
  x: number,
  y: number,
  width: number,
  r: number,
  g: number,
  b: number,
  a = 255,
) {
  if (x < 0 || y < 0) return;
  if (x >= width) return;
  const idx = (y * width + x) * 4;
  if (idx < 0 || idx + 3 >= buf.length) return;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

const GLYPH_ROWS_5X7: Record<string, number[]> = {
  "0": [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  "1": [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  "2": [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  "3": [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  "4": [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  "5": [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  "6": [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  "7": [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  "8": [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  "9": [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100],

  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
};

function drawGlyph5x7(params: {
  buf: Buffer;
  width: number;
  x: number;
  y: number;
  char: string;
  scale: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  const rows = GLYPH_ROWS_5X7[params.char];
  if (!rows) return;
  for (let row = 0; row < 7; row += 1) {
    const bits = rows[row] ?? 0;
    for (let col = 0; col < 5; col += 1) {
      const on = (bits & (1 << (4 - col))) !== 0;
      if (!on) continue;
      for (let dy = 0; dy < params.scale; dy += 1) {
        for (let dx = 0; dx < params.scale; dx += 1) {
          fillPixel(
            params.buf,
            params.x + col * params.scale + dx,
            params.y + row * params.scale + dy,
            params.width,
            params.color.r,
            params.color.g,
            params.color.b,
            params.color.a ?? 255,
          );
        }
      }
    }
  }
}

function drawText(params: {
  buf: Buffer;
  width: number;
  x: number;
  y: number;
  text: string;
  scale: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  const text = params.text.toUpperCase();
  let cursorX = params.x;
  for (const raw of text) {
    const ch = raw in GLYPH_ROWS_5X7 ? raw : raw.toUpperCase();
    drawGlyph5x7({
      buf: params.buf,
      width: params.width,
      x: cursorX,
      y: params.y,
      char: ch,
      scale: params.scale,
      color: params.color,
    });
    cursorX += 6 * params.scale;
  }
}

function measureTextWidthPx(text: string, scale: number) {
  return text.length * 6 * scale - scale; // 5px glyph + 1px space
}

export function renderCatNoncePngBase64(nonce: string): string {
  const top = "CAT";
  const bottom = nonce.toUpperCase();

  const scale = 12;
  const pad = 18;
  const gap = 18;

  const topWidth = measureTextWidthPx(top, scale);
  const bottomWidth = measureTextWidthPx(bottom, scale);
  const width = Math.max(topWidth, bottomWidth) + pad * 2;
  const height = pad * 2 + 7 * scale + gap + 7 * scale;

  const buf = Buffer.alloc(width * height * 4, 255);
  const black = { r: 0, g: 0, b: 0 };

  drawText({
    buf,
    width,
    x: Math.floor((width - topWidth) / 2),
    y: pad,
    text: top,
    scale,
    color: black,
  });

  drawText({
    buf,
    width,
    x: Math.floor((width - bottomWidth) / 2),
    y: pad + 7 * scale + gap,
    text: bottom,
    scale,
    color: black,
  });

  const png = encodePngRgba(buf, width, height);
  return png.toString("base64");
}
