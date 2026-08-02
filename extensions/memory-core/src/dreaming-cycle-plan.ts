export type DreamingCyclePhase = "light" | "deep" | "rem";

export type DreamingSleepWindow = {
  start: string;
  end: string;
};

export type DreamingCycleStep = {
  id: string;
  cycle: number;
  phase: DreamingCyclePhase;
  kind: "phase" | "final-commit";
  offsetMinutes: number;
  minuteOfDay: number;
  deepWeight: number;
  remWeight: number;
  requires: string[];
};

export type DreamingCyclePlan = {
  startMinute: number;
  endMinute: number;
  durationMinutes: number;
  cycleMinutes: number;
  steps: DreamingCycleStep[];
};

const DEFAULT_SLEEP_WINDOW: DreamingSleepWindow = { start: "23:00", end: "07:00" };
const DEFAULT_CYCLE_COUNT = 5;
const MIN_SLEEP_WINDOW_MINUTES = 300;
const MAX_SLEEP_WINDOW_MINUTES = 720;

function parseClock(value: string, label: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`${label} must use HH:mm`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`${label} must be a valid 24-hour time`);
  }
  return hour * 60 + minute;
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function buildDreamingCyclePlan(params: {
  sleepWindow?: DreamingSleepWindow;
  cycles?: number;
} = {}): DreamingCyclePlan {
  const sleepWindow = params.sleepWindow ?? DEFAULT_SLEEP_WINDOW;
  const cycles = params.cycles ?? DEFAULT_CYCLE_COUNT;
  if (!Number.isInteger(cycles) || cycles < 3 || cycles > 8) {
    throw new Error("dreaming cycles must be an integer between 3 and 8");
  }

  const startMinute = parseClock(sleepWindow.start, "sleepWindow.start");
  const endMinute = parseClock(sleepWindow.end, "sleepWindow.end");
  if (startMinute === endMinute) {
    throw new Error("sleep window start and end must differ");
  }
  const durationMinutes = (endMinute - startMinute + 24 * 60) % (24 * 60);
  if (
    durationMinutes < MIN_SLEEP_WINDOW_MINUTES ||
    durationMinutes > MAX_SLEEP_WINDOW_MINUTES
  ) {
    throw new Error("sleep window must be between 5 and 12 hours");
  }

  const cycleMinutes = Math.round(durationMinutes / cycles);
  const steps: DreamingCycleStep[] = [];
  let previousId: string | undefined;
  const appendStep = (step: Omit<DreamingCycleStep, "requires" | "minuteOfDay">): void => {
    steps.push({
      ...step,
      minuteOfDay: (startMinute + step.offsetMinutes) % (24 * 60),
      requires: previousId ? [previousId] : [],
    });
    previousId = step.id;
  };

  for (let index = 0; index < cycles; index += 1) {
    const cycle = index + 1;
    const baseOffset = Math.round((durationMinutes * index) / cycles);
    const nextOffset = Math.round((durationMinutes * cycle) / cycles);
    const span = nextOffset - baseOffset;
    const deepWeight = roundWeight((cycles - index) / cycles);
    const remWeight = roundWeight(cycle / cycles);
    const common = { cycle, kind: "phase" as const, deepWeight, remWeight };
    appendStep({
      ...common,
      id: `cycle-${cycle}-light`,
      phase: "light",
      offsetMinutes: baseOffset,
    });
    appendStep({
      ...common,
      id: `cycle-${cycle}-deep`,
      phase: "deep",
      offsetMinutes: baseOffset + Math.round(span * 0.28),
    });
    appendStep({
      ...common,
      id: `cycle-${cycle}-rem`,
      phase: "rem",
      offsetMinutes: baseOffset + Math.round(span * 0.72),
    });
  }

  const lastOffset = steps.at(-1)?.offsetMinutes ?? 0;
  appendStep({
    id: "final-deep-commit",
    cycle: cycles,
    phase: "deep",
    kind: "final-commit",
    offsetMinutes: Math.max(lastOffset + 1, durationMinutes - 10),
    deepWeight: 0.2,
    remWeight: 1,
  });

  return { startMinute, endMinute, durationMinutes, cycleMinutes, steps };
}
