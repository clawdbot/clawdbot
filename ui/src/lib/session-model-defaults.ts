// Shared helpers for comparing session rows against list defaults.
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";

type SessionModelFields = Pick<GatewaySessionRow, "agentRuntime" | "model" | "modelProvider">;

export function sessionModelMatchesDefaults(
  session: SessionModelFields | null | undefined,
  defaults: SessionsListResult["defaults"] | undefined,
): boolean {
  const sessionRuntime = session?.agentRuntime?.id?.trim();
  const defaultRuntime = defaults?.agentRuntime?.id?.trim();
  return (
    (!session?.modelProvider || session.modelProvider === defaults?.modelProvider) &&
    (!session?.model || session.model === defaults?.model) &&
    (!sessionRuntime || !defaultRuntime || sessionRuntime === defaultRuntime)
  );
}
