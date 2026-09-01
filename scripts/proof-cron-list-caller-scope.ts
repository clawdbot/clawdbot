import path from "node:path";
import { pathToFileURL } from "node:url";

function describeProofError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return JSON.stringify(error) ?? "unknown error";
}

async function main(): Promise<void> {
  const entrypoint = path.join(process.cwd(), "src/gateway/server-methods/cron.ts");
  const { cronHandlers } = await import(pathToFileURL(entrypoint).href);

  const visible = {
    id: "visible",
    name: "visible automation",
    agentId: "ops",
    enabled: true,
    payload: { kind: "agentTurn" },
    schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
    state: {},
  };
  const hidden = {
    id: "hidden",
    name: "hidden automation",
    agentId: "worker",
    enabled: true,
    payload: { kind: "agentTurn" },
    schedule: { kind: "at", at: new Date(Date.now() + 60_000).toISOString() },
    state: {},
  };

  let response: unknown;
  let responseError: unknown;
  await cronHandlers["cron.list"]({
    req: {} as never,
    params: { includeDisabled: true, compact: true } as never,
    respond: ((ok: boolean, payload: unknown, error: unknown) => {
      if (ok) {
        response = payload;
      } else {
        responseError = error;
      }
    }) as never,
    context: {
      cron: {
        getDefaultAgentId: () => "main",
        listPage: async () => ({
          jobs: [visible, hidden],
          snapshotRevision: "source-includes-hidden-job",
          total: 2,
          offset: 0,
          limit: 200,
          hasMore: false,
          nextOffset: null,
        }),
      },
      getRuntimeConfig: () => ({}),
    } as never,
    client: {
      internal: {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "ops",
          sessionKey: "agent:ops:main",
        },
      },
    } as never,
    isWebchatConnect: () => false,
  });

  if (responseError || !response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error(
      `cron.list proof failed: ${describeProofError(responseError ?? "missing response")}`,
    );
  }
  const result = response as {
    jobs: Array<{ id: string }>;
    total: number;
    visibility?: { restricted?: boolean };
  };

  if (process.argv.includes("--negative-control")) {
    console.log(
      JSON.stringify({
        returnedJobIds: result.jobs.map((job) => job.id),
        hiddenJobRedacted: !result.jobs.some((job) => job.id === "hidden"),
        restrictedViewMarked: result.visibility?.restricted === true,
      }),
    );
    return;
  }

  console.log(
    JSON.stringify({
      total: result.total,
      returnedJobIds: result.jobs.map((job) => job.id),
      exposedFields: Object.keys(result),
      hasRestrictedViewMarker: "visibility" in result,
    }),
  );
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
