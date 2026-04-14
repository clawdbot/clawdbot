declare module "qrcode-terminal" {
  type GenerateOptions = {
    small?: boolean;
  };

  type QrCodeTerminal = {
    generate: (input: string, options?: GenerateOptions, cb?: (output: string) => void) => void;
  };

  const qrcode: QrCodeTerminal;
  export default qrcode;
}

declare module "qrcode-terminal/vendor/QRCode/index.js" {
  const QRCode: unknown;
  export default QRCode;
}

declare module "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js" {
  const QRErrorCorrectLevel: Record<string, unknown>;
  export default QRErrorCorrectLevel;
}
