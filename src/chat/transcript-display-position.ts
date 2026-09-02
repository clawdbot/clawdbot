import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";

const ordinal = z.number().int().nonnegative();
const positionSchema = z
  .object({
    source: z.string().min(1).max(128),
    rawSeq: ordinal,
    activity: z
      .object({
        afterRawSeq: ordinal.nullable(),
        scopeId: z.string().min(1).max(1024),
        startOrder: ordinal,
      })
      .optional(),
  })
  .refine(
    ({ rawSeq, activity }) =>
      !activity || activity.afterRawSeq === null || activity.afterRawSeq < rawSeq,
  );

export type TranscriptDisplayPosition = z.infer<typeof positionSchema>;

/** Public placement metadata is bounded and never supplies execution authority. */
export function readTranscriptDisplayPosition(
  value: unknown,
): TranscriptDisplayPosition | undefined {
  if (!asOptionalRecord(value)) {
    return undefined;
  }
  const parsed = positionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Recompose presentation after pages/events merge, without changing physical cursor order. */
export function composeTranscriptDisplay<T>(
  values: T[],
  messageFor: (value: T) => unknown = (value) => value,
): T[] {
  const output: T[] = [];
  let start = 0;
  let positions: TranscriptDisplayPosition[] = [];
  let activities: number[] = [];
  let previousStableSeq: number | undefined;
  let monotonic = true;
  const flush = () => {
    if (positions.length === 0) {
      return;
    }
    const current = positions;
    const activityIndexes = activities;
    const recompose = monotonic && activityIndexes.length > 0;
    positions = [];
    activities = [];
    previousStableSeq = undefined;
    monotonic = true;
    if (!recompose) {
      return;
    }
    // Positions index the collected output tail. Detach only segments that need
    // recomposition, preserving each value captured by the message selector.
    const selected = output.splice(start);
    const ordered = activityIndexes.toSorted((left, right) => {
      const a = current[left]!.activity!.afterRawSeq;
      const b = current[right]!.activity!.afterRawSeq;
      if (a === b) {
        return current[left]!.rawSeq - current[right]!.rawSeq;
      }
      if (a === null) {
        return -1;
      }
      return b === null ? 1 : a - b;
    });
    let next = 0;
    const emitGap = (beforeRawSeq?: number) => {
      let cohorts: Map<string, { firstSeq: number; rows: number[] }> | undefined;
      while (next < ordered.length) {
        const index = ordered[next]!;
        const position = current[index]!;
        const activity = position.activity!;
        if (
          beforeRawSeq !== undefined &&
          activity.afterRawSeq !== null &&
          activity.afterRawSeq >= beforeRawSeq
        ) {
          break;
        }
        cohorts ??= new Map();
        let cohort = cohorts.get(activity.scopeId);
        if (!cohort) {
          cohort = { firstSeq: position.rawSeq, rows: [] };
          cohorts.set(activity.scopeId, cohort);
        }
        cohort.firstSeq = Math.min(cohort.firstSeq, position.rawSeq);
        cohort.rows.push(index);
        next += 1;
      }
      if (!cohorts) {
        return;
      }
      // Scope cohorts keep a total order; comparing ordinals only for matching
      // scopes inside one comparator would be non-transitive across attempts.
      for (const cohort of [...cohorts.values()].toSorted((a, b) => a.firstSeq - b.firstSeq)) {
        const sorted = cohort.rows.toSorted(
          (a, b) =>
            current[a]!.activity!.startOrder - current[b]!.activity!.startOrder ||
            current[a]!.rawSeq - current[b]!.rawSeq,
        );
        for (const index of sorted) {
          output.push(selected[index]!);
        }
      }
    };
    for (let index = 0; index < current.length; index += 1) {
      const position = current[index]!;
      if (!position.activity) {
        emitGap(position.rawSeq);
        output.push(selected[index]!);
      }
    }
    emitGap();
  };
  for (const value of values) {
    const metadata = asOptionalRecord(asOptionalRecord(messageFor(value))?.["__openclaw"]);
    const position = readTranscriptDisplayPosition(metadata?.transcriptPosition);
    // Optimistic/uncoordinated rows and different rewrite generations are causal
    // barriers. A later canonical snapshot can place them; timestamps cannot.
    if (!position) {
      flush();
      output.push(value);
      start = output.length;
      continue;
    }
    if (positions.at(-1)?.source !== position.source) {
      flush();
      start = output.length;
    }
    if (position.activity) {
      activities.push(positions.length);
    } else {
      monotonic &&= previousStableSeq === undefined || previousStableSeq <= position.rawSeq;
      previousStableSeq = position.rawSeq;
    }
    positions.push(position);
    output.push(value);
  }
  flush();
  return output.every((value, index) => value === values[index]) ? values : output;
}
