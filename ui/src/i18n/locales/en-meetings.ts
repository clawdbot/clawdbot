import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enMeetings = {
  meetings: {
    refresh: "Refresh",
    loading: "Loading meetings…",
    emptyTitle: "Your meeting notes, together",
    emptyBody: "Meetings appear here once Discord voice or a meeting plugin captures a transcript.",
    docs: "Set up meeting transcripts",
    select: "Select a meeting to read its notes.",
    inProgress: "In progress",
    utterances: "{count} utterances",
    participants: "Participants",
    notesSource: "Notes: {source}",
    noNotes: "No notes have been saved for this meeting yet.",
    activeNotes: "Capture is in progress. Refresh to check for notes.",
    noSpeech: "No speech captured",
    loadingNotes: "Loading notes…",
    listLabel: "Meetings by day",
  },
} satisfies TranslationMap;

export const registerMeetingsEnglish = Object.assign(
  () => {
    Object.assign(en, enMeetings);
  },
  { catalog: enMeetings },
);
