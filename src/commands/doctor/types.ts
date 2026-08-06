/** Shared doctor JSON shapes used by repair modules that inspect loose config records. */
export type DoctorAccountRecord = Record<string, unknown>;
type DoctorAllowFromEntry = string | number;
export type DoctorAllowFromList = DoctorAllowFromEntry[];
