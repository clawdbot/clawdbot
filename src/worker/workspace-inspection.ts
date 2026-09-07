import {
  getSessionWorkspaceFile,
  listSessionWorkspaceFiles,
  setSessionWorkspaceFile,
} from "../gateway/server-methods/workspace-files.js";
import { loadCheckoutDiff } from "../sessions/session-diff.js";
import {
  parseWorkspaceInspectionInput,
  WORKSPACE_INSPECTION_MAX_BYTES,
  type WorkspaceInspectionResult,
} from "./workspace-inspection-protocol.js";

/** The node owns the root; requests cannot select another workspace or host path. */
export async function inspectSessionWorkspace(
  root: string,
  input: string | undefined,
  assertCurrent: () => void,
): Promise<string> {
  const request = parseWorkspaceInspectionInput(input);
  const workspace = { root, fileRoot: root, diffCwd: root };
  assertCurrent();
  let result: WorkspaceInspectionResult<"list" | "get" | "set" | "diff">;
  switch (request.operation) {
    case "list":
      result = await listSessionWorkspaceFiles({ ...workspace, ...request });
      break;
    case "get":
      result = await getSessionWorkspaceFile({ ...workspace, ...request });
      break;
    case "set":
      result = await setSessionWorkspaceFile({ ...workspace, ...request, assertCurrent });
      break;
    case "diff": {
      const checkout = {
        cwd: root,
        sessionKey: request.sessionKey,
        baseCommit: request.baseCommit,
      };
      let diff: Awaited<ReturnType<typeof loadCheckoutDiff>>;
      if (request.scope === "commit") {
        if (request.commit === undefined) {
          throw new Error("INVALID_REQUEST: commit inspection requires a commit");
        }
        diff = await loadCheckoutDiff({ ...checkout, scope: "commit", commit: request.commit });
      } else {
        diff = await loadCheckoutDiff({ ...checkout, scope: request.scope });
      }
      // JSON escaping can exceed the raw patch budget. Keep every changed entry
      // and its statistics, but omit oversized patches before transport encoding.
      let bytes = Buffer.byteLength(JSON.stringify(diff));
      for (const file of diff.files.toReversed()) {
        if (bytes <= WORKSPACE_INSPECTION_MAX_BYTES) {
          break;
        }
        if (file.patch !== undefined) {
          const before = Buffer.byteLength(JSON.stringify(file));
          delete file.patch;
          file.truncated = true;
          bytes += Buffer.byteLength(JSON.stringify(file)) - before;
          if (!diff.truncated) {
            diff.truncated = true;
            bytes += Buffer.byteLength(',"truncated":true');
          }
        }
      }
      result = diff;
      break;
    }
  }
  assertCurrent();
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) > WORKSPACE_INSPECTION_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: workspace inspection result exceeds its bound");
  }
  return serialized;
}
