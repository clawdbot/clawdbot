import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Reader and capture-editor copy loads with either lazy surface; shared search labels stay eager.
const enTranscripts = {
  transcripts: {
    library: "Transcript library",
    reader: "Transcript reader",
    filters: "Filter meeting transcripts",
    advancedFilters: "Filters",
    titleFilter: "Title or source ID",
    sourceFilter: "Provider ID",
    accountFilter: "Account ID",
    agentFilter: "Agent ID",
    afterFilter: "Started on or after",
    beforeFilter: "Started before",
    filterHint:
      "Dates use UTC. Provider, account, and agent IDs are exact matches; title and source IDs use literal text matching. Meeting URLs are not searched.",
    filter: "Filter",
    clearFilters: "Clear filters",
    pagination: "Transcript pages",
    firstPage: "First page",
    nextPage: "Next page",
    emptyHint:
      "Try clearing the filters, or set up a source in Meeting capture. Agent chat history is on the Sessions page.",
    choose: "Select a transcript",
    chooseHint:
      "Select a transcript to read the conversation, search its text, or download a copy.",
    forbidden: "Transcript access is restricted",
    forbiddenHint:
      "This connection needs operator read access and permission to read the shared archive. Ask a Gateway administrator to review your access.",
    loadError: "Could not load transcripts",
    disconnected: "Connect to the Gateway to read meeting transcripts.",
    unknown: "Unknown",
    unattributed: "Agent not recorded",
    savedCount: "{count} saved utterances",
    sourceDetails: "Source details",
    sourceTime: "Source time: {time}",
    lastUtterance: "Last source utterance: {time}",
    unknownSpeaker: "Unknown speaker",
    armedHint:
      "Armed: a capture subscription is registered. This does not confirm audio is being received or saved.",
    inactiveHint: "No active capture subscription is reported for this transcript.",
    back: "Back to library",
    text: "Transcript",
    summary: "Summary",
    summaryHint: "Check the transcript before relying on decisions or action items.",
    modelNotes: "Model-generated notes",
    heuristicNotes: "Notes extracted using text heuristics",
    generatedAt: "Generated {time}",
    noSummary: "No stored summary is available. Reading this page does not generate one.",
    searchWithin: "Search within this transcript",
    search: "Search",
    clearSearch: "Clear search",
    searchResults: "Matching utterances for “{query}” across this transcript, loaded in pages.",
    noMatches: "No matching utterances.",
    noUtterances: "No utterances have been saved in this transcript.",
    loadMore: "Load more",
    windowHint:
      "Earlier loaded pages have left this reading window. Download for the full transcript or return to the beginning.",
    readerStart: "Read from beginning",
    download: { markdown: "Download Markdown", jsonl: "Download JSONL" },
    exportError:
      "Download failed. No partial file was downloaded. Try again, or use the Transcripts CLI for exports over the browser limit.",
    exporting: "Preparing download…",
    downloadStarted: "Download started. Check your browser downloads.",
  },
  meetingCapture: {
    advancedSettings: "Advanced settings",
    enabled: "Enable transcript storage",
    enabledHint:
      "Enabled by default. This permits capture; it does not start recording a voice channel by itself.",
    libraryHint: "Read, search, and download saved meeting transcripts.",
    observedState: "Observed capture setting",
    stateHint: "Reported by the Gateway. An unsaved or not-yet-applied draft may differ.",
    latestTranscript: "Most recently updated saved transcript",
    noSaved: "No saved transcript was reported.",
    lastUtterance: "Latest utterance source time",
    health: "Capture health",
    healthError: "Capture health is unknown because the Gateway read failed.",
    sourcesHint:
      "A source opts in to capture when applied by the Gateway. Removing an entry stops its configured auto-start capture after the change takes effect; saved notes remain.",
    noSources: "No sources are configured for auto-start.",
    addSource: "Add source",
    editSource: "Edit source",
    edit: "Edit",
    editSourceNumber: "Edit source {number}",
    removeSourceNumber: "Remove source {number}",
    saveSource: "Save source",
    requiredLocator: "Enter a non-blank value for {field}.",
    chooseProvider: "Choose a provider",
    autoStartUnavailable:
      "Auto-start setup is unavailable for this provider. Existing fields remain editable. Check the provider's setup documentation; after enabling its plugin or restarting the Gateway, refresh health.",
    noAutoStartProviders:
      "No enabled provider currently advertises auto-start setup. Check the provider's setup documentation and refresh health after enabling its plugin or restarting the Gateway. Existing sources remain editable.",
    sourceChanged:
      "This source changed while you were editing. Cancel and reopen it to use the current draft.",
    rawDraftPending:
      "Save or discard the pending raw config draft in Advanced before editing capture sources here.",
    sessionIdHint:
      "Optional custom ID for continuous capture. Leave it empty for generated IDs and avoid reusing IDs from the same day.",
    occupancySessionIdHint:
      "Occupancy mode chooses session IDs automatically and ignores this saved value.",
    titleHint:
      "Used for future captures. Changing only the title keeps the current capture running without renaming current or saved notes.",
    startDiagnostics: {
      starting: "Capture is starting. Refresh health to check the outcome.",
      retrying:
        "The Gateway is retrying capture startup. Check the provider configuration and refresh health.",
      "id-conflict":
        "This session ID conflicts with an existing capture. Choose a different ID, or leave it empty for generated IDs.",
      "admitted-start-failed":
        "Capture startup failed after the transcript was created and cannot retry automatically. Saved notes are retained. Check the provider configuration and refresh health.",
      "start-failed":
        "Capture could not start. Check the source and provider configuration, then restart the Gateway and refresh health.",
      ended:
        "The provider ended this capture attempt. Saved notes are retained. Check the provider configuration and refresh health.",
    },
    locatorsHint:
      "Required locators come from the provider. Existing fields are preserved even when the provider is unavailable.",
    sourceHealth: "Applied source state",
    armedHint:
      "Armed means a registered capture subscription, not confirmed recording. Not active means no subscription was found; unknown means the Gateway cannot establish the current state.",
    safetyHint:
      "Recording is opt-in. Joining voice is not recording, and recording participants does not grant them command, tool, or agent permissions.",
    durationHint:
      "Sources capture continuously unless occupancy mode is enabled. Occupancy mode saves notes after the room empties and may continue a capture from the same source and agent within ten minutes.",
    sttHint:
      "Speech-to-text may send audio to your configured transcription provider and incur provider usage. This library does not store or play raw audio.",
    omitted: "{count} additional health entries are not shown in this bounded response.",
    states: {
      enabled: "Enabled",
      disabled: "Disabled",
      armed: "Armed",
      "not-active": "Not active",
      unknown: "Unknown",
    },
    availability: {
      enabled: "Plugin enabled",
      disabled: "Plugin disabled",
      unavailable: "Unavailable",
      unknown: "Availability unknown",
    },
    fields: {
      providerId: "Provider",
      title: "Title",
      accountId: "Account ID",
      guildId: "Guild ID",
      channelId: "Channel ID",
      meetingUrl: "Meeting URL",
      sessionId: "Custom session ID",
    },
  },
} satisfies TranslationMap;

export const registerTranscriptsEnglish = Object.assign(
  () => {
    en.transcripts = enTranscripts.transcripts;
    // SAFETY: The eager catalog owns meetingCapture as an object containing shared search labels.
    Object.assign(en.meetingCapture as TranslationMap, enTranscripts.meetingCapture);
  },
  { catalog: enTranscripts },
);
