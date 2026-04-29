import type QRCode from "qrcode";

type QrCodeRuntime = typeof QRCode;

let qrCodeRuntimePromise: Promise<QrCodeRuntime> | null = null;

export async function loadQrCodeRuntime(): Promise<QrCodeRuntime> {
  if (!qrCodeRuntimePromise) {
    qrCodeRuntimePromise = import("qrcode").then((mod) => mod.default ?? mod);
  }
  return await qrCodeRuntimePromise;
}

export function normalizeQrText(text: string): string {
  if (typeof text !== "string") {
    throw new TypeError("QR text must be a string.");
  }
  if (text.length === 0) {
    throw new Error("QR text must not be empty.");
  }
  return text;
}
