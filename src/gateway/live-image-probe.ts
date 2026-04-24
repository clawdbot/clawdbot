import { encodePngRgba, fillPixel } from "../media/png-encode.js";

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
  if (!rows) {
    return;
  }
  for (let row = 0; row < 7; row += 1) {
    const bits = rows[row] ?? 0;
    for (let col = 0; col < 5; col += 1) {
      const on = (bits & (1 << (4 - col))) !== 0;
      if (!on) {
        continue;
      }
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

function fillRect(params: {
  buf: Buffer;
  width: number;
  height: number;
  x: number;
  y: number;
  w: number;
  h: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  const startX = Math.max(0, params.x);
  const startY = Math.max(0, params.y);
  const endX = Math.min(params.width, params.x + params.w);
  const endY = Math.min(params.height, params.y + params.h);
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      fillPixel(
        params.buf,
        x,
        y,
        params.width,
        params.color.r,
        params.color.g,
        params.color.b,
        params.color.a ?? 255,
      );
    }
  }
}

function fillEllipse(params: {
  buf: Buffer;
  width: number;
  height: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  for (
    let y = Math.max(0, params.cy - params.ry);
    y <= Math.min(params.height - 1, params.cy + params.ry);
    y += 1
  ) {
    for (
      let x = Math.max(0, params.cx - params.rx);
      x <= Math.min(params.width - 1, params.cx + params.rx);
      x += 1
    ) {
      const dx = (x - params.cx) / params.rx;
      const dy = (y - params.cy) / params.ry;
      if (dx * dx + dy * dy <= 1) {
        fillPixel(
          params.buf,
          x,
          y,
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

function fillTriangle(params: {
  buf: Buffer;
  width: number;
  height: number;
  a: { x: number; y: number };
  b: { x: number; y: number };
  c: { x: number; y: number };
  color: { r: number; g: number; b: number; a?: number };
}) {
  const minX = Math.max(0, Math.min(params.a.x, params.b.x, params.c.x));
  const maxX = Math.min(params.width - 1, Math.max(params.a.x, params.b.x, params.c.x));
  const minY = Math.max(0, Math.min(params.a.y, params.b.y, params.c.y));
  const maxY = Math.min(params.height - 1, Math.max(params.a.y, params.b.y, params.c.y));
  const area =
    (params.b.x - params.a.x) * (params.c.y - params.a.y) -
    (params.b.y - params.a.y) * (params.c.x - params.a.x);
  if (area === 0) {
    return;
  }
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const w0 =
        (params.b.x - params.a.x) * (y - params.a.y) - (params.b.y - params.a.y) * (x - params.a.x);
      const w1 =
        (params.c.x - params.b.x) * (y - params.b.y) - (params.c.y - params.b.y) * (x - params.b.x);
      const w2 =
        (params.a.x - params.c.x) * (y - params.c.y) - (params.a.y - params.c.y) * (x - params.c.x);
      if ((w0 <= 0 && w1 <= 0 && w2 <= 0) || (w0 >= 0 && w1 >= 0 && w2 >= 0)) {
        fillPixel(
          params.buf,
          x,
          y,
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

function drawBlockCatLabel(params: {
  buf: Buffer;
  width: number;
  height: number;
  x: number;
  y: number;
  color: { r: number; g: number; b: number; a?: number };
}) {
  const t = 12;
  const h = 78;
  const w = 58;
  const gap = 20;
  const cX = params.x;
  const aX = cX + w + gap;
  const tX = aX + w + gap;

  fillRect({ ...params, x: cX, y: params.y, w, h: t, color: params.color });
  fillRect({ ...params, x: cX, y: params.y, w: t, h, color: params.color });
  fillRect({ ...params, x: cX, y: params.y + h - t, w, h: t, color: params.color });

  fillRect({ ...params, x: aX, y: params.y, w, h: t, color: params.color });
  fillRect({ ...params, x: aX, y: params.y, w: t, h, color: params.color });
  fillRect({ ...params, x: aX + w - t, y: params.y, w: t, h, color: params.color });
  fillRect({
    ...params,
    x: aX,
    y: params.y + Math.floor((h - t) / 2),
    w,
    h: t,
    color: params.color,
  });

  fillRect({ ...params, x: tX, y: params.y, w, h: t, color: params.color });
  fillRect({
    ...params,
    x: tX + Math.floor((w - t) / 2),
    y: params.y,
    w: t,
    h,
    color: params.color,
  });
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

export function renderSolidColorPngBase64(color: { r: number; g: number; b: number }): string {
  const width = 192;
  const height = 192;
  const buf = Buffer.alloc(width * height * 4, 255);
  fillRect({
    buf,
    width,
    height,
    x: 0,
    y: 0,
    w: width,
    h: height,
    color,
  });
  const png = encodePngRgba(buf, width, height);
  return png.toString("base64");
}

export function renderCatFacePngBase64(): string {
  const width = 256;
  const height = 288;
  const buf = Buffer.alloc(width * height * 4, 255);
  const outline = { r: 40, g: 40, b: 40 };
  const innerEar = { r: 245, g: 182, b: 193 };
  const nose = { r: 222, g: 102, b: 138 };
  const whisker = { r: 30, g: 30, b: 30 };

  fillTriangle({
    buf,
    width,
    height,
    a: { x: 62, y: 74 },
    b: { x: 106, y: 12 },
    c: { x: 134, y: 88 },
    color: outline,
  });
  fillTriangle({
    buf,
    width,
    height,
    a: { x: 194, y: 74 },
    b: { x: 150, y: 12 },
    c: { x: 122, y: 88 },
    color: outline,
  });
  fillTriangle({
    buf,
    width,
    height,
    a: { x: 80, y: 70 },
    b: { x: 106, y: 34 },
    c: { x: 122, y: 80 },
    color: innerEar,
  });
  fillTriangle({
    buf,
    width,
    height,
    a: { x: 176, y: 70 },
    b: { x: 150, y: 34 },
    c: { x: 134, y: 80 },
    color: innerEar,
  });
  fillEllipse({
    buf,
    width,
    height,
    cx: 128,
    cy: 112,
    rx: 78,
    ry: 66,
    color: outline,
  });
  fillEllipse({
    buf,
    width,
    height,
    cx: 98,
    cy: 100,
    rx: 9,
    ry: 12,
    color: { r: 255, g: 255, b: 255 },
  });
  fillEllipse({
    buf,
    width,
    height,
    cx: 158,
    cy: 100,
    rx: 9,
    ry: 12,
    color: { r: 255, g: 255, b: 255 },
  });
  fillEllipse({
    buf,
    width,
    height,
    cx: 128,
    cy: 130,
    rx: 22,
    ry: 17,
    color: { r: 255, g: 255, b: 255 },
  });
  fillTriangle({
    buf,
    width,
    height,
    a: { x: 128, y: 122 },
    b: { x: 118, y: 136 },
    c: { x: 138, y: 136 },
    color: nose,
  });
  fillRect({ buf, width, height, x: 127, y: 136, w: 2, h: 15, color: whisker });
  fillRect({ buf, width, height, x: 74, y: 134, w: 42, h: 2, color: whisker });
  fillRect({ buf, width, height, x: 140, y: 134, w: 42, h: 2, color: whisker });
  fillRect({ buf, width, height, x: 80, y: 146, w: 34, h: 2, color: whisker });
  fillRect({ buf, width, height, x: 142, y: 146, w: 34, h: 2, color: whisker });
  drawBlockCatLabel({
    buf,
    width,
    height,
    x: 21,
    y: 190,
    color: outline,
  });

  const png = encodePngRgba(buf, width, height);
  return png.toString("base64");
}
