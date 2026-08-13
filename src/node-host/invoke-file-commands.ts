import { listHostDirectories } from "../infra/host-directory-listing.js";
import { NODE_FS_LIST_DIR_COMMAND, NODE_TERMINAL_UPLOAD_COMMAND } from "../infra/node-commands.js";
import { stageTerminalUpload } from "../infra/terminal-file-upload.js";

type NodeFileCommandResult = { payload: unknown } | { error: unknown };

function decodeParams(raw?: string | null): Record<string, unknown> {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("INVALID_REQUEST: paramsJSON malformed JSON");
  }
}

/** Handles bounded node-host filesystem commands before plugin dispatch. */
export async function invokeNodeFileCommand(
  command: string,
  paramsJSON?: string | null,
): Promise<NodeFileCommandResult | null> {
  if (command !== NODE_FS_LIST_DIR_COMMAND && command !== NODE_TERMINAL_UPLOAD_COMMAND) {
    return null;
  }
  try {
    const params = decodeParams(paramsJSON);
    if (command === NODE_FS_LIST_DIR_COMMAND) {
      if (params.path !== undefined && typeof params.path !== "string") {
        throw new Error("INVALID_REQUEST: path must be a string");
      }
      return { payload: await listHostDirectories(params.path) };
    }
    if (typeof params.name !== "string" || typeof params.contentBase64 !== "string") {
      throw new Error("INVALID_REQUEST: terminal upload name and content are required");
    }
    return {
      payload: await stageTerminalUpload({
        name: params.name,
        contentBase64: params.contentBase64,
      }),
    };
  } catch (error) {
    return { error };
  }
}
