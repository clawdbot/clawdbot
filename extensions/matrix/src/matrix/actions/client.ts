import { withResolvedRuntimeMatrixClient } from "../client-bootstrap.js";
import { resolveMatrixRoomId } from "../send.js";
import type { MatrixActionClient, MatrixActionClientOpts } from "./types.js";

type MatrixActionClientStopMode = "stop" | "persist" | "discard";

export async function withResolvedActionClient<T>(
  opts: MatrixActionClientOpts,
  run: (client: MatrixActionClient["client"]) => Promise<T>,
  mode: MatrixActionClientStopMode = "stop",
): Promise<T> {
  return await withResolvedRuntimeMatrixClient(opts, run, mode);
}

export async function withStartedActionClient<T>(
  opts: MatrixActionClientOpts,
  run: (client: MatrixActionClient["client"]) => Promise<T>,
): Promise<T> {
  return await withResolvedActionClient({ ...opts, readiness: "started" }, run, "persist");
}

export async function withResolvedRoomAction<T>(
  roomId: string,
  opts: MatrixActionClientOpts,
  run: (client: MatrixActionClient["client"], resolvedRoom: string) => Promise<T>,
): Promise<T> {
  return await withResolvedActionClient(opts, async (client) => {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    return await run(client, resolvedRoom);
  });
}
