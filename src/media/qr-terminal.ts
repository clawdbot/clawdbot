import { loadQrCodeRuntime, normalizeQrText } from "./qr-runtime.ts";

export async function renderQrTerminal(
  input: string,
  opts: { small?: boolean } = {},
): Promise<string> {
  const qrCode = await loadQrCodeRuntime();
  return await qrCode.toString(normalizeQrText(input), {
    small: opts.small ?? false,
    type: "terminal",
  });
}
