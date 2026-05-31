//#region packages/normalization-core/src/record-coerce.d.ts
declare function isRecord(value: unknown): value is Record<string, unknown>;
declare function asRecord(value: unknown): Record<string, unknown>;
declare function readStringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined;
declare function asOptionalRecord(value: unknown): Record<string, unknown> | undefined;
declare function asNullableRecord(value: unknown): Record<string, unknown> | null;
declare function asOptionalObjectRecord(value: unknown): Record<string, unknown> | undefined;
declare function asNullableObjectRecord(value: unknown): Record<string, unknown> | null;
//#endregion
export { asNullableObjectRecord, asNullableRecord, asOptionalObjectRecord, asOptionalRecord, asRecord, isRecord, readStringField };