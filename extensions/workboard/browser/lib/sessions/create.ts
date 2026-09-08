import type { SessionsCreateParams, SessionsCreateResult } from "@openclaw/gateway-protocol";
import { normalizeOptionalString as stringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type SessionCreateOutcome = {
  key: string;
  entry?: Readonly<Record<string, unknown>>;
  initialRun:
    | { status: "idle" }
    | { status: "started"; runId?: string }
    | { status: "rejected"; error: string };
};

export async function requestSessionCreate(
  client: Pick<GatewayBrowserClient, "request">,
  params: SessionsCreateParams = {},
): Promise<SessionCreateOutcome> {
  const result = await client.request<SessionsCreateResult>("sessions.create", params);
  const key = stringValue(result?.key);
  if (!key) {
    throw new Error("sessions.create returned no key");
  }
  let initialRun: SessionCreateOutcome["initialRun"] = { status: "idle" };
  if (result.runStarted) {
    const runId = stringValue(result.runId);
    initialRun = {
      status: "started",
      ...(runId ? { runId } : {}),
    };
  } else if (result.runError !== undefined) {
    initialRun = {
      status: "rejected",
      error:
        stringValue(result.runError?.message) ||
        "The session was created, but its first message could not be sent.",
    };
  }
  return { key, entry: result.entry, initialRun };
}
