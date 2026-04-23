import { loadQrCodeTuiRuntime } from "./qr-runtime.ts";

export async function renderQrTerminal(
  input: string,
  opts: { small?: boolean } = {},
): Promise<string> {
  const { renderTerminal } = await loadQrCodeTuiRuntime();
  return await renderTerminal(input, { small: opts.small ?? true });
}
