import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const SUBAGENT_SPAWN_ADMISSION_SLOTS_KEY: unique symbol = Symbol.for(
  "openclaw.subagentSpawnAdmissionSlots",
);

export type SubagentSpawnAdmissionSlot = {
  id: string;
  requesterSessionKey: string;
  runId: string;
  childSessionKey?: string;
  release: () => void;
};

type AdmissionSlotState = {
  nextId: number;
  byRequester: Map<string, Set<SubagentSpawnAdmissionSlot>>;
};

function getAdmissionSlotState(): AdmissionSlotState {
  return resolveGlobalSingleton<AdmissionSlotState>(SUBAGENT_SPAWN_ADMISSION_SLOTS_KEY, () => ({
    nextId: 0,
    byRequester: new Map(),
  }));
}

export function countPendingSubagentSpawnAdmissionSlots(
  requesterSessionKey: string,
  options?: { exclude?: SubagentSpawnAdmissionSlot },
): number {
  const key = requesterSessionKey.trim();
  if (!key) {
    return 0;
  }
  const slots = getAdmissionSlotState().byRequester.get(key);
  if (!slots) {
    return 0;
  }
  let count = 0;
  for (const slot of slots) {
    if (slot === options?.exclude) {
      continue;
    }
    count += 1;
  }
  return count;
}

export function reserveSubagentSpawnAdmissionSlot(params: {
  requesterSessionKey: string;
  runId: string;
  childSessionKey?: string;
}): SubagentSpawnAdmissionSlot {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    throw new Error("subagent spawn admission requires a requester session key");
  }
  const state = getAdmissionSlotState();
  const slots = state.byRequester.get(requesterSessionKey) ?? new Set<SubagentSpawnAdmissionSlot>();
  state.byRequester.set(requesterSessionKey, slots);
  let released = false;
  const slot: SubagentSpawnAdmissionSlot = {
    id: `subagent-admission-${(state.nextId += 1)}`,
    requesterSessionKey,
    runId: params.runId,
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
    release: () => {
      if (released) {
        return;
      }
      released = true;
      slots.delete(slot);
      if (slots.size === 0) {
        state.byRequester.delete(requesterSessionKey);
      }
    },
  };
  slots.add(slot);
  return slot;
}

export function resetSubagentSpawnAdmissionForTests(): void {
  const state = getAdmissionSlotState();
  state.nextId = 0;
  state.byRequester.clear();
}
