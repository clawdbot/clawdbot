// QR runtime helpers lazily load QR code generation and normalize QR text.
import type QRCode from "qrcode";
import { createLazyImportLoader } from "../shared/lazy-promise.js";

type QrCodeRuntime = typeof QRCode;

const qrCodeRuntimeLoader = createLazyImportLoader<QrCodeRuntime>(() =>
  import("qrcode").then((mod) => mod.default ?? mod),
);

/** Loads the qrcode package lazily so QR support does not affect media startup paths. */
export async function loadQrCodeRuntime(): Promise<QrCodeRuntime> {
  return await qrCodeRuntimeLoader.load();
}

/** Validates QR text before passing it to the renderer runtime. */
export function normalizeQrText(text: string): string {
  if (typeof text !== "string") {
    throw new TypeError("QR text must be a string.");
  }
  if (text.length === 0) {
    throw new Error("QR text must not be empty.");
  }
  return text;
}
