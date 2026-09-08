import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMeetings = {
  meetings: {
    emptyTitle: "Your meeting notes, together",
    docs: "Set up meeting transcripts",
    inProgress: "In progress",
    activeNotes: "Capture is in progress. Refresh to check for notes.",
    noSpeech: "No speech captured",
    listLabel: "Meetings by day",
  },
} satisfies TranslationMap;

export const registerMeetingsEnglish = Object.assign(
  () => {
    Object.assign(en, enMeetings);
  },
  { catalog: enMeetings },
);
