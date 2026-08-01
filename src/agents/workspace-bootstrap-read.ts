import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";

// Workspace bootstrap files are model context, not arbitrary attachments. Keep every
// read path on the same bound so compaction and sandbox copies cannot bypass it.
export const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024;

export async function readWorkspaceBootstrapFile(fd: number): Promise<string> {
  return (await readFileDescriptorBounded(fd, MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES)).toString(
    "utf-8",
  );
}
