import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
// Matrix plugin module implements credentials write behavior.
import type {
  saveBackfilledMatrixDeviceId as saveBackfilledMatrixDeviceIdType,
  saveMatrixCredentials as saveMatrixCredentialsType,
  touchMatrixCredentials as touchMatrixCredentialsType,
} from "./credentials.js";

const loadMatrixCredentialsRuntime = createLazyRuntimeModule(() => import("./credentials.js"));

export async function saveMatrixCredentials(
  ...args: Parameters<typeof saveMatrixCredentialsType>
): ReturnType<typeof saveMatrixCredentialsType> {
  const runtime = await loadMatrixCredentialsRuntime();
  return runtime.saveMatrixCredentials(...args);
}

export async function saveBackfilledMatrixDeviceId(
  ...args: Parameters<typeof saveBackfilledMatrixDeviceIdType>
): ReturnType<typeof saveBackfilledMatrixDeviceIdType> {
  const runtime = await loadMatrixCredentialsRuntime();
  return runtime.saveBackfilledMatrixDeviceId(...args);
}

export async function touchMatrixCredentials(
  ...args: Parameters<typeof touchMatrixCredentialsType>
): ReturnType<typeof touchMatrixCredentialsType> {
  const runtime = await loadMatrixCredentialsRuntime();
  return runtime.touchMatrixCredentials(...args);
}
