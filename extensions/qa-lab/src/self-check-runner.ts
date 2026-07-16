import { startQaLabServer } from "./lab-server.js";

export async function runQaLabSelfCheck(params?: { repoRoot?: string; outputPath?: string }) {
  const server = await startQaLabServer({
    repoRoot: params?.repoRoot,
    outputPath: params?.outputPath,
  });
  try {
    return await server.runSelfCheck();
  } finally {
    await server.stop();
  }
}

export const runQaE2eSelfCheck = runQaLabSelfCheck;
