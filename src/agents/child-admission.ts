import { isSubagentSpawnDepthAllowed } from "../config/agent-limits.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

export type ChildAdmissionCap =
  | "subagents.maxSpawnDepth"
  | "subagents.maxChildrenPerAgent"
  | "tools.swarm.maxChildrenPerGroup"
  | "tools.swarm.maxTotalPerGroup";

type ChildAdmissionResult =
  | { ok: true }
  | { ok: false; governingCap: ChildAdmissionCap; error: string };

type ChildAdmissionParams = {
  callerDepth: number;
  maxSpawnDepth: number;
  activeChildren: number;
  maxActiveChildren: number;
} & ({ collect: false } | { collect: true; totalChildren: number; maxTotalChildren: number });

/** ACP child keys deduplicate task rows; symbols keep anonymous starts distinct. */
const pendingChildAdmissions = resolveGlobalMap<string, Set<string | symbol>>(
  Symbol.for("openclaw.pendingChildAdmissions"),
  "close-only",
);

type ReservableChildAdmission = { ok: true } | { ok: false };

type ChildAdmissionReservation<TAdmission extends ReservableChildAdmission> =
  | Extract<TAdmission, { ok: false }>
  | (Extract<TAdmission, { ok: true }> & { release: () => void });

type ChildAdmissionReservationParams<TAdmission extends ReservableChildAdmission> = {
  controllerSessionKey: string;
  childSessionKey?: string;
  resolveAdmission: (
    pendingChildren: number,
    pendingChildSessionKeys: ReadonlySet<string>,
  ) => TAdmission;
};

// Infer the complete decision once so native, ACP, and visible payloads survive narrowing.
export function reserveChildAdmissionSlot<TAdmission extends ReservableChildAdmission>(
  params: ChildAdmissionReservationParams<TAdmission>,
): ChildAdmissionReservation<TAdmission>;
export function reserveChildAdmissionSlot(
  params: ChildAdmissionReservationParams<ReservableChildAdmission>,
): ChildAdmissionReservation<ReservableChildAdmission> {
  const pending = pendingChildAdmissions.get(params.controllerSessionKey) ?? new Set();
  const pendingChildSessionKeys = new Set(
    [...pending].filter((sessionKey): sessionKey is string => typeof sessionKey === "string"),
  );
  const admission = params.resolveAdmission(pending.size, pendingChildSessionKeys);
  if (!admission.ok) {
    return admission;
  }
  const reservation = params.childSessionKey ?? Symbol("pending child admission");
  pending.add(reservation);
  pendingChildAdmissions.set(params.controllerSessionKey, pending);
  return {
    ...admission,
    release() {
      if (!pending.delete(reservation)) {
        return;
      }
      if (pending.size === 0) {
        pendingChildAdmissions.delete(params.controllerSessionKey);
      }
    },
  };
}

const rejectChildAdmission = (
  governingCap: ChildAdmissionCap,
  error: string,
): ChildAdmissionResult => ({ ok: false, governingCap, error });

export function resolveChildAdmission(params: ChildAdmissionParams): ChildAdmissionResult {
  if (!isSubagentSpawnDepthAllowed(params.callerDepth, params.maxSpawnDepth)) {
    return rejectChildAdmission(
      "subagents.maxSpawnDepth",
      `sessions_spawn is not allowed at this depth (current depth: ${params.callerDepth}, max: ${params.maxSpawnDepth}; agents.defaults.subagents.maxSpawnDepth).`,
    );
  }
  if (params.collect && params.totalChildren >= params.maxTotalChildren) {
    return rejectChildAdmission(
      "tools.swarm.maxTotalPerGroup",
      `sessions_spawn reached tools.swarm.maxTotalPerGroup (${params.totalChildren}/${params.maxTotalChildren}).`,
    );
  }
  if (params.activeChildren < params.maxActiveChildren) {
    return { ok: true };
  }
  return params.collect
    ? rejectChildAdmission(
        "tools.swarm.maxChildrenPerGroup",
        `sessions_spawn reached tools.swarm.maxChildrenPerGroup (${params.activeChildren}/${params.maxActiveChildren}).`,
      )
    : rejectChildAdmission(
        "subagents.maxChildrenPerAgent",
        `sessions_spawn has reached max active children for this session (${params.activeChildren}/${params.maxActiveChildren}; agents.defaults.subagents.maxChildrenPerAgent).`,
      );
}
