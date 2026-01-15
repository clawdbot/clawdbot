import { createMatrixClient, isBunRuntime } from "./client.js";

export type MatrixProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  userId?: string | null;
};

export async function probeMatrix(params: {
  homeserver: string;
  accessToken: string;
  userId?: string;
  timeoutMs: number;
}): Promise<MatrixProbe> {
  const started = Date.now();
  const result: MatrixProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };
  if (isBunRuntime()) {
    return {
      ...result,
      error: "Matrix probe requires Node (bun runtime not supported)",
      elapsedMs: Date.now() - started,
    };
  }
  if (!params.homeserver?.trim()) {
    return {
      ...result,
      error: "missing homeserver",
      elapsedMs: Date.now() - started,
    };
  }
  if (!params.accessToken?.trim()) {
    return {
      ...result,
      error: "missing access token",
      elapsedMs: Date.now() - started,
    };
  }
  try {
    const client = await createMatrixClient({
      homeserver: params.homeserver,
      userId: params.userId ?? "",
      accessToken: params.accessToken,
      localTimeoutMs: params.timeoutMs,
    });
    const res = await client.whoami();
    result.ok = true;
    result.userId = res.user_id ?? null;

    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      status:
        typeof err === "object" && err && "httpStatus" in err
          ? Number((err as { httpStatus?: number }).httpStatus)
          : result.status,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}
