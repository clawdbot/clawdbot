import { z } from "zod";
import { BOARD_WIDGET_PROPS_MAX_BYTES, BoardValidationError } from "./board-layout.js";

export const BOARD_REPORT_WIDGET_KIND = "session:report";
export const BOARD_REPORT_GUIDANCE =
  'Report data: {blocks:[...]}. Blocks: text {text,title?}; metrics {items:[{label,value,detail?}]}; table {columns,rows,title?}; chart {points:[{label,value}],style?:"bar"|"line",title?}; links {items:[{label,url,detail?}],title?}. Every block needs its type. Metric values and table cells are strings; chart values are numbers. Maximum 8KB JSON, 24 blocks, 8 metrics or columns, 40 rows or chart points, 20 links per block. Links must be HTTP(S). No HTML, scripts, styles, network reads, or executable actions.';

const title = z.string().min(1).max(120).optional();
const label = z.string().min(1).max(160);
const detail = z.string().max(240).optional();
const cell = z.string().max(500);
const table = z
  .strictObject({
    type: z.literal("table"),
    title,
    columns: z.array(label).min(1).max(8),
    rows: z.array(z.array(cell).max(8)).max(40),
  })
  .refine((value) => value.rows.every((row) => row.length === value.columns.length), {
    message: "Every table row must match the columns",
  });

const reportSchema = z.strictObject({
  blocks: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("text"), title, text: z.string().min(1).max(4_000) }),
        z.strictObject({
          type: z.literal("metrics"),
          items: z
            .array(z.strictObject({ label, value: z.string().min(1).max(80), detail }))
            .min(1)
            .max(8),
        }),
        table,
        z.strictObject({
          type: z.literal("chart"),
          title,
          style: z.enum(["bar", "line"]).optional(),
          points: z
            .array(
              z.strictObject({
                label,
                value: z.number().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
              }),
            )
            .min(1)
            .max(40),
        }),
        z.strictObject({
          type: z.literal("links"),
          title,
          items: z
            .array(
              z.strictObject({
                label,
                url: z.url({ protocol: /^https?$/, normalize: true }).max(2_048),
                detail,
              }),
            )
            .min(1)
            .max(20),
        }),
      ]),
    )
    .min(1)
    .max(24),
});

export type BoardReport = z.infer<typeof reportSchema>;

/** Data-only reports run in the host document, so executable fields are never accepted. */
export function parseBoardReport(value: unknown): BoardReport {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > BOARD_WIDGET_PROPS_MAX_BYTES) {
    throw new BoardValidationError("invalid_operation", "Report exceeds 8KB JSON budget");
  }
  const result = reportSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new BoardValidationError(
      "invalid_operation",
      `Invalid report at ${issue?.path.join(".") || "root"}: ${issue?.message}`,
    );
  }
  return result.data;
}
