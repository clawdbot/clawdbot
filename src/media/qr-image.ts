import { encodePngRgba, fillPixel } from "./png-encode.ts";

type QRCodeConstructor = new (
  typeNumber: number,
  errorCorrectLevel: unknown,
) => {
  addData: (data: string) => void;
  make: () => void;
  getModuleCount: () => number;
  isDark: (row: number, col: number) => boolean;
};

let qrCodeRuntimePromise: Promise<{
  QRCode: QRCodeConstructor;
  QRErrorCorrectLevel: Record<string, unknown>;
}> | null = null;

async function loadQrCodeRuntime() {
  if (!qrCodeRuntimePromise) {
    qrCodeRuntimePromise = Promise.all([
      import("qrcode-terminal/vendor/QRCode/index.js"),
      import("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js"),
    ]).then(([qrCodeModule, errorCorrectLevelModule]) => ({
      QRCode: qrCodeModule.default as QRCodeConstructor,
      QRErrorCorrectLevel: errorCorrectLevelModule.default,
    }));
  }
  return await qrCodeRuntimePromise;
}

async function createQrMatrix(input: string) {
  const { QRCode, QRErrorCorrectLevel } = await loadQrCodeRuntime();
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();
  return qr;
}

export async function renderQrPngBase64(
  input: string,
  opts: { scale?: number; marginModules?: number } = {},
): Promise<string> {
  const { scale = 6, marginModules = 4 } = opts;
  const qr = await createQrMatrix(input);
  const modules = qr.getModuleCount();
  const size = (modules + marginModules * 2) * scale;

  const buf = Buffer.alloc(size * size * 4, 255);
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!qr.isDark(row, col)) {
        continue;
      }
      const startX = (col + marginModules) * scale;
      const startY = (row + marginModules) * scale;
      for (let y = 0; y < scale; y += 1) {
        const pixelY = startY + y;
        for (let x = 0; x < scale; x += 1) {
          const pixelX = startX + x;
          fillPixel(buf, pixelX, pixelY, size, 0, 0, 0, 255);
        }
      }
    }
  }

  const png = encodePngRgba(buf, size, size);
  return png.toString("base64");
}
