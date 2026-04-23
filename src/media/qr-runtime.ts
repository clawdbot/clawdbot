let qrCodeTuiRuntimePromise: Promise<typeof import("@vincentkoc/qrcode-tui")> | null = null;

export async function loadQrCodeTuiRuntime() {
  if (!qrCodeTuiRuntimePromise) {
    qrCodeTuiRuntimePromise = import("@vincentkoc/qrcode-tui");
  }
  return await qrCodeTuiRuntimePromise;
}
