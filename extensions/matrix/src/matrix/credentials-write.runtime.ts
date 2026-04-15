import type {
  saveBackfilledMatrixDeviceId as saveBackfilledMatrixDeviceIdType,
  saveMatrixCredentials as saveMatrixCredentialsType,
  touchMatrixCredentials as touchMatrixCredentialsType,
} from "./credentials.js";

export async function saveMatrixCredentials(
  ...args: Parameters<typeof saveMatrixCredentialsType>
): ReturnType<typeof saveMatrixCredentialsType> {
  const runtime = await import("./credentials.js");
  return runtime.saveMatrixCredentials(...args);
}

export async function saveBackfilledMatrixDeviceId(
  ...args: Parameters<typeof saveBackfilledMatrixDeviceIdType>
): ReturnType<typeof saveBackfilledMatrixDeviceIdType> {
  const runtime = await import("./credentials.js");
  return runtime.saveBackfilledMatrixDeviceId(...args);
}

export async function touchMatrixCredentials(
  ...args: Parameters<typeof touchMatrixCredentialsType>
): ReturnType<typeof touchMatrixCredentialsType> {
  const runtime = await import("./credentials.js");
  return runtime.touchMatrixCredentials(...args);
}
