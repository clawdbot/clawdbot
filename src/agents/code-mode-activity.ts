import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type CodeModeRunFinalQuiescence = "quiescent" | "non_quiescent" | "unavailable";

declare const codeModeActivityOwnerBrand: unique symbol;

export type CodeModeActivityOwner = Readonly<{
  [codeModeActivityOwnerBrand]: true;
}>;

export type CodeModeActivityContext = {
  readonly codeModeActivityOwner?: CodeModeActivityOwner;
};

export type CodeModeOwnedActivityContext = {
  readonly codeModeActivityOwner: CodeModeActivityOwner;
};

type CodeModeRunActivity = {
  engaged: boolean;
  activeControls: number;
  unsettledBridgeEntries: number;
  parkedSnapshots: number;
  settlementWaiters: Set<() => void>;
};

type CodeModeActivityCounter = "activeControls" | "unsettledBridgeEntries" | "parkedSnapshots";

type CodeModeActivityState = {
  activityByOwner: WeakMap<CodeModeActivityOwner, CodeModeRunActivity>;
  retainedOwners: Map<CodeModeActivityOwner, CodeModeRunActivity>;
};

const CODE_MODE_ACTIVITY_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.codeModeActivityState"),
  (): CodeModeActivityState => ({
    activityByOwner: new WeakMap(),
    retainedOwners: new Map(),
  }),
);
const activityByOwner = CODE_MODE_ACTIVITY_STATE.activityByOwner;
const retainedOwners = CODE_MODE_ACTIVITY_STATE.retainedOwners;

export function createCodeModeActivityOwner(): CodeModeActivityOwner {
  return Object.freeze({}) as CodeModeActivityOwner;
}

function isActivitySettled(activity: CodeModeRunActivity): boolean {
  return (
    activity.activeControls === 0 &&
    activity.unsettledBridgeEntries === 0 &&
    activity.parkedSnapshots === 0
  );
}

function resolveActivitySettlement(activity: CodeModeRunActivity): void {
  if (!isActivitySettled(activity)) {
    return;
  }
  for (const resolve of activity.settlementWaiters) {
    resolve();
  }
  activity.settlementWaiters.clear();
}

export function ensureCodeModeActivityOwner<T extends CodeModeActivityContext>(
  ctx: T,
): T & CodeModeOwnedActivityContext {
  return ctx.codeModeActivityOwner
    ? (ctx as T & CodeModeOwnedActivityContext)
    : { ...ctx, codeModeActivityOwner: createCodeModeActivityOwner() };
}

function beginActivity(
  owner: CodeModeActivityOwner | undefined,
  field: CodeModeActivityCounter,
): () => void {
  if (!owner) {
    return () => {};
  }
  const activity = activityByOwner.get(owner);
  if (!activity) {
    return () => {};
  }
  activity.engaged = true;
  activity[field] += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const current = activityByOwner.get(owner);
    if (current === activity) {
      current[field] = Math.max(0, current[field] - 1);
      resolveActivitySettlement(current);
    }
  };
}

export function registerCodeModeRunActivity(owner: CodeModeActivityOwner | undefined): void {
  if (!owner || activityByOwner.has(owner)) {
    return;
  }
  activityByOwner.set(owner, {
    engaged: false,
    activeControls: 0,
    unsettledBridgeEntries: 0,
    parkedSnapshots: 0,
    settlementWaiters: new Set(),
  });
}

export function beginCodeModeControlActivity(owner: CodeModeActivityOwner | undefined): () => void {
  return beginActivity(owner, "activeControls");
}

export function beginCodeModeBridgeActivity(owner: CodeModeActivityOwner | undefined): () => void {
  return beginActivity(owner, "unsettledBridgeEntries");
}

export function beginCodeModeSnapshotActivity(
  owner: CodeModeActivityOwner | undefined,
): () => void {
  return beginActivity(owner, "parkedSnapshots");
}

export function sampleCodeModeRunFinalQuiescence(
  owner: CodeModeActivityOwner | undefined,
): CodeModeRunFinalQuiescence {
  const activity = owner ? activityByOwner.get(owner) : undefined;
  if (!activity?.engaged) {
    return "unavailable";
  }
  return isActivitySettled(activity) ? "quiescent" : "non_quiescent";
}

/** Await every control, bridge entry, and parked snapshot owned by one command. */
export function waitForCodeModeRunActivitySettlement(
  owner: CodeModeActivityOwner | undefined,
): Promise<void> {
  const activity = owner ? activityByOwner.get(owner) : undefined;
  if (!activity || isActivitySettled(activity)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    activity.settlementWaiters.add(resolve);
    resolveActivitySettlement(activity);
  });
}

/**
 * Keep a non-quiescent owner alive until its last physical activity settles.
 * The callback runs synchronously with the final activity release.
 */
export function retainCodeModeRunActivityUntilSettlement(
  owner: CodeModeActivityOwner | undefined,
  onSettled: () => void,
): boolean {
  const activity = owner ? activityByOwner.get(owner) : undefined;
  if (!owner || !activity || isActivitySettled(activity)) {
    return false;
  }
  retainedOwners.set(owner, activity);
  activity.settlementWaiters.add(() => {
    retainedOwners.delete(owner);
    onSettled();
  });
  resolveActivitySettlement(activity);
  return true;
}

export function discardCodeModeRunActivity(owner: CodeModeActivityOwner | undefined): void {
  if (owner) {
    retainedOwners.delete(owner);
    activityByOwner.delete(owner);
  }
}
