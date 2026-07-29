/** Minimal ambient types for the qrcode package. */
declare module "qrcode" {
  /** Error correction level accepted by qrcode renderers. */
  export type QrCodeErrorCorrectionLevel =
    | "L"
    | "M"
    | "Q"
    | "H"
    | "low"
    | "medium"
    | "quartile"
    | "high";

  /** Foreground/background color options for rendered QR codes. */
  export type QrCodeColorOptions = {
    dark?: string;
    light?: string;
  };

  /** Shared QR render options used by string, data URL, and file outputs. */
  export type QrCodeRenderOptions = {
    color?: QrCodeColorOptions;
    errorCorrectionLevel?: QrCodeErrorCorrectionLevel;
    margin?: number;
    scale?: number;
    small?: boolean;
    type?: "image/png" | "png" | "svg" | "terminal" | "utf8";
    width?: number;
  };

  /** Symbol matrix returned by qrcode.create. */
  export type QrCodeSymbol = {
    modules: {
      data: ArrayLike<boolean | number>;
      size: number;
    };
  };

  /** Create an in-memory QR symbol. */
  export function create(text: string, options?: QrCodeRenderOptions): QrCodeSymbol;
  /** Render a QR code to a string format. */
  export function toString(text: string, options?: QrCodeRenderOptions): Promise<string>;
  /** Render a QR code to a data URL. */
  export function toDataURL(text: string, options?: QrCodeRenderOptions): Promise<string>;
  /** Render a QR code to a PNG buffer. */
  export function toBuffer(text: string, options?: QrCodeRenderOptions): Promise<Buffer>;

  /** Default qrcode export with the functions OpenClaw uses. */
  const qrcode: {
    create: typeof create;
    toString: typeof toString;
    toDataURL: typeof toDataURL;
    toBuffer: typeof toBuffer;
  };

  export default qrcode;
}
