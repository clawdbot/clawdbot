// Doctor note emission helpers that sanitize user-visible repair output.
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";

/** Strip terminal control sequences from a potentially multi-line doctor note. */
export function sanitizeDoctorNote(note: string): string {
  return note
    .split("\n")
    .map((line) => sanitizeForLog(line))
    .join("\n");
}

/** Emit grouped doctor change, info, and warning notes with sanitized content. */
export function emitDoctorNotes(params: {
  note: (message: string, title?: string) => void;
  changeNotes?: string[];
  infoNotes?: string[];
  warningNotes?: string[];
}): void {
  for (const change of params.changeNotes ?? []) {
    params.note(sanitizeDoctorNote(change), "Doctor changes");
  }
  for (const info of params.infoNotes ?? []) {
    params.note(sanitizeDoctorNote(info), "Doctor info");
  }
  for (const warning of params.warningNotes ?? []) {
    params.note(sanitizeDoctorNote(warning), "Doctor warnings");
  }
}
