import { TerminalStates, type CallRecord, type CallState, type TranscriptEntry } from "../types.js";

const ConversationStates = new Set<CallState>(["speaking", "listening"]);

const StateOrder: readonly CallState[] = [
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening",
];

export function transitionState(call: CallRecord, newState: CallState): void {
  // No-op for same state or already terminal.
  if (call.state === newState || TerminalStates.has(call.state)) {
    return;
  }

  // Terminal states can always be reached from non-terminal.
  if (TerminalStates.has(newState)) {
    call.state = newState;
    return;
  }

  // Allow cycling between speaking and listening (multi-turn conversations).
  if (ConversationStates.has(call.state) && ConversationStates.has(newState)) {
    call.state = newState;
    return;
  }

  // Only allow forward transitions in state order.
  const currentIndex = StateOrder.indexOf(call.state);
  const newIndex = StateOrder.indexOf(newState);
  if (newIndex > currentIndex) {
    call.state = newState;
  }
}

export function addTranscriptEntry(call: CallRecord, speaker: "bot" | "user", text: string): void {
  const entry: TranscriptEntry = {
    timestamp: Date.now(),
    speaker,
    text,
    isFinal: true,
  };
  call.transcript.push(entry);
}
