// Whatsapp plugin module implements login qr runtime behavior.
type StartWebLoginWithQr = typeof import("./src/login-qr.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("./src/login-qr.js").waitForWebLogin;

let loginQrModulePromise: Promise<typeof import("./src/login-qr.js")> | null = null;

function loadLoginQrModule() {
  loginQrModulePromise ??= import("./src/login-qr.js");
  return loginQrModulePromise;
}

export async function startWebLoginWithQr(
  ...args: Parameters<StartWebLoginWithQr>
): ReturnType<StartWebLoginWithQr> {
  const { startWebLoginWithQr: startWebLoginWithQrLocal } = await loadLoginQrModule();
  return await startWebLoginWithQrLocal(...args);
}

export async function waitForWebLogin(
  ...args: Parameters<WaitForWebLogin>
): ReturnType<WaitForWebLogin> {
  const { waitForWebLogin: waitForWebLoginLocal } = await loadLoginQrModule();
  return await waitForWebLoginLocal(...args);
}
