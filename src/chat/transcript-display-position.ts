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
  const parsed = positionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Recompose presentation after pages/events merge, without changing physical cursor order. */
export function composeTranscriptDisplay<T>(
  values: T[],
  messageFor: (value: T) => unknown = (value) => value,
): T[] {
  type Row = { value: T; position: TranscriptDisplayPosition };
  const output: T[] = [];
  let segment: Row[] = [];
  const flush = () => {
    const rows = segment;
    segment = [];
    const stable = rows.filter((row) => !row.position.activity);
    const monotonic = stable.every((row, index) => {
      const previous = stable[index - 1];
      return !previous || previous.position.rawSeq <= row.position.rawSeq;
    });
    const activities = rows.flatMap((row) =>
      row.position.activity ? [{ ...row, activity: row.position.activity }] : [],
    );
    if (!monotonic || activities.length === 0) {
      for (const row of rows) {
        output.push(row.value);
      }
      return;
    }
    const ordered = activities.toSorted((left, right) => {
      const a = left.activity.afterRawSeq;
      const b = right.activity.afterRawSeq;
      if (a === b) {
        return left.position.rawSeq - right.position.rawSeq;
      }
      if (a === null) {
        return -1;
      }
      return b === null ? 1 : a - b;
    });
    const iterator = ordered.values();
    let next = iterator.next();
    const emitGap = (beforeRawSeq?: number) => {
      const cohorts = new Map<string, { firstSeq: number; rows: typeof activities }>();
      while (!next.done) {
        const row = next.value;
        const afterRawSeq = row.activity.afterRawSeq;
        if (beforeRawSeq !== undefined && afterRawSeq !== null && afterRawSeq >= beforeRawSeq) {
          break;
        }
        let cohort = cohorts.get(row.activity.scopeId);
        if (!cohort) {
          cohort = { firstSeq: row.position.rawSeq, rows: [] };
          cohorts.set(row.activity.scopeId, cohort);
        }
        cohort.firstSeq = Math.min(cohort.firstSeq, row.position.rawSeq);
        cohort.rows.push(row);
        next = iterator.next();
      }
      // Scope cohorts keep a total order; comparing ordinals only for matching
      // scopes inside one comparator would be non-transitive across attempts.
      for (const cohort of [...cohorts.values()].toSorted((a, b) => a.firstSeq - b.firstSeq)) {
        const sorted = cohort.rows.toSorted(
          (a, b) =>
            a.activity.startOrder - b.activity.startOrder || a.position.rawSeq - b.position.rawSeq,
        );
        for (const row of sorted) {
          output.push(row.value);
        }
      }
    };
    for (const row of stable) {
      emitGap(row.position.rawSeq);
      output.push(row.value);
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
      continue;
    }
    if (segment.at(-1)?.position.source !== position.source) {
      flush();
    }
    segment.push({ value, position });
  }
  flush();
  return output.every((value, index) => value === values[index]) ? values : output;
}
