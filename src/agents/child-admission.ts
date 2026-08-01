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

const rejectChildAdmission = (
  governingCap: ChildAdmissionCap,
  error: string,
): ChildAdmissionResult => ({ ok: false, governingCap, error });

export function resolveChildAdmission(params: ChildAdmissionParams): ChildAdmissionResult {
  if (params.callerDepth >= params.maxSpawnDepth) {
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
