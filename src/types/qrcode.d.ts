declare module "qrcode" {
  export type QrCodeErrorCorrectionLevel =
    | "L"
    | "M"
    | "Q"
    | "H"
    | "low"
    | "medium"
    | "quartile"
    | "high";

  export type QrCodeColorOptions = {
    dark?: string;
    light?: string;
  };

  export type QrCodeRenderOptions = {
    color?: QrCodeColorOptions;
    errorCorrectionLevel?: QrCodeErrorCorrectionLevel;
    margin?: number;
    scale?: number;
    small?: boolean;
    type?: "image/png" | "png" | "svg" | "terminal" | "utf8";
    width?: number;
  };

  export function toString(text: string, options?: QrCodeRenderOptions): Promise<string>;
  export function toDataURL(text: string, options?: QrCodeRenderOptions): Promise<string>;
  export function toFile(
    filePath: string,
    text: string,
    options?: QrCodeRenderOptions,
  ): Promise<void>;

  const qrcode: {
    toString: typeof toString;
    toDataURL: typeof toDataURL;
    toFile: typeof toFile;
  };

  export default qrcode;
}
