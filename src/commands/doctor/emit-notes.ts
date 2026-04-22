import { sanitizeForLog } from "../../terminal/ansi.js";

export function sanitizeDoctorNote(note: string): string {
  return note
    .split("\n")
    .map((line) => sanitizeForLog(line))
    .join("\n");
}

export function emitDoctorNotes(params: {
  note: (message: string, title?: string) => void;
  changeNotes?: string[];
  warningNotes?: string[];
}): void {
  for (const change of params.changeNotes ?? []) {
    params.note(sanitizeDoctorNote(change), "Doctor changes");
  }
  for (const warning of params.warningNotes ?? []) {
    params.note(sanitizeDoctorNote(warning), "Doctor warnings");
  }
}
