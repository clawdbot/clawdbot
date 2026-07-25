import "./stage-sandbox-media.js";

type StageSandboxMediaTestApi = {
  scpFile(remoteHost: string, remotePath: string, localPath: string): Promise<void>;
};

function getTestApi(): StageSandboxMediaTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.stageSandboxMediaTestApi")
  ];
  if (!api) {
    throw new Error("sandbox media test API is unavailable");
  }
  return api as StageSandboxMediaTestApi;
}

export const testing = {
  async scpFile(remoteHost: string, remotePath: string, localPath: string): Promise<void> {
    await getTestApi().scpFile(remoteHost, remotePath, localPath);
  },
};
