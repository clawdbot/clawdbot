export function isNodeBridgeTestEnv() {
  return process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
}
