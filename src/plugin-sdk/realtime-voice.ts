/**
 * Public SDK subpath for realtime voice provider types, runtime helpers, and talk events.
 */
export type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
export type {
  RealtimeVoiceAudioFormat,
  RealtimeVoiceBargeInOptions,
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceBridgeEvent,
  RealtimeVoiceBrowserSession,
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderCapabilities,
  RealtimeVoiceCloseReason,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderConfiguredContext,
  RealtimeVoiceProviderId,
  RealtimeVoiceProviderResolveConfigContext,
  RealtimeVoiceRole,
  RealtimeVoiceTool,
  RealtimeVoiceToolCallEvent,
  RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
export {
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
} from "../talk/provider-types.js";
export {
  createTalkEventSequencer,
  TALK_EVENT_TYPES,
  type TalkBrain,
  type TalkEvent,
  type TalkEventContext,
  type TalkEventInput,
  type TalkEventSequencer,
  type TalkEventType,
  type TalkMode,
  type TalkTransport,
} from "../talk/talk-events.js";
export { createTalkDiagnosticEvent, recordTalkDiagnosticEvent } from "../talk/diagnostics.js";
export { createTalkLogRecord, recordTalkLogEvent } from "../talk/logging.js";
export { recordTalkObservabilityEvent } from "../talk/observability.js";
export {
  createTalkSessionController,
  normalizeTalkTransport,
  type TalkEnsureTurnResult,
  type TalkSessionControllerOptions,
  type TalkSessionController,
  type TalkSessionControllerParams,
  type TalkTurnFailure,
  type TalkTurnFailureReason,
  type TalkTurnResult,
  type TalkTurnSuccess,
} from "../talk/talk-session-controller.js";
export {
  REALTIME_VOICE_ACTIVATION_NAME_MAX_WORDS,
  isSupportedRealtimeVoiceActivationName,
  matchRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationName,
  normalizeRealtimeVoiceActivationNamePrefix,
  normalizeSupportedRealtimeVoiceActivationName,
  realtimeVoiceActivationNameWordCount,
  sortRealtimeVoiceActivationNames,
  type RealtimeVoiceActivationNameEdge,
  type RealtimeVoiceActivationNameMatchKind,
  type RealtimeVoiceActivationNameTranscriptResult,
} from "../talk/activation-name.js";
export {
  classifySkippableRealtimeVoiceConsultTranscript,
  type SkippableRealtimeVoiceConsultTranscriptReason,
} from "../talk/consult-transcript.js";
export {
  matchRealtimeVoiceConsultQuestions,
  normalizeRealtimeVoiceConsultQuestion,
  readRealtimeVoiceConsultQuestion,
  readSpeakableRealtimeVoiceToolResult,
  type RealtimeVoiceConsultQuestionMatchOptions,
  type RealtimeVoiceSpeakableToolResultOptions,
} from "../talk/consult-question.js";
export {
  createRealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinatorOptions,
  type RealtimeVoiceForcedConsultHandle,
  type RealtimeVoiceForcedConsultNativeMatch,
  type RealtimeVoiceForcedConsultNativeRecentOptions,
  type RealtimeVoiceForcedConsultTimer,
} from "../talk/forced-consult-coordinator.js";
export {
  createRealtimeVoiceTurnContextTracker,
  type RealtimeVoiceTurnContextHandle,
  type RealtimeVoiceTurnContextTracker,
  type RealtimeVoiceTurnContextTrackerOptions,
} from "../talk/turn-context-tracker.js";
export {
  createRealtimeVoiceOutputActivityTracker,
  type RealtimeVoiceOutputActivityDelta,
  type RealtimeVoiceOutputActivitySnapshot,
  type RealtimeVoiceOutputActivityTracker,
  type RealtimeVoiceOutputActivityTrackerOptions,
} from "../talk/output-activity-tracker.js";
export {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  buildRealtimeVoiceAgentConsultPrompt,
  buildRealtimeVoiceAgentConsultWorkingResponse,
  collectRealtimeVoiceAgentConsultVisibleText,
  isRealtimeVoiceAgentConsultToolPolicy,
  parseRealtimeVoiceAgentConsultArgs,
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  resolveRealtimeVoiceAgentConsultToolsAllow,
  type RealtimeVoiceAgentConsultArgs,
  type RealtimeVoiceAgentConsultToolPolicy,
  type RealtimeVoiceAgentConsultTranscriptEntry,
} from "../talk/agent-consult-tool.js";
export {
  assertRealtimeVoiceAgentConsultModelSelectionUnlocked,
  consultRealtimeVoiceAgent,
  type RealtimeVoiceAgentConsultResult,
  type RealtimeVoiceAgentConsultRuntime,
} from "../talk/agent-consult-runtime.js";
export {
  createRealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentTalkbackQueue,
  type RealtimeVoiceAgentTalkbackQueueParams,
  type RealtimeVoiceAgentTalkbackResult,
} from "../talk/agent-talkback-runtime.js";
export {
  buildRealtimeVoiceAgentCancelProviderResult,
  buildRealtimeVoiceAgentControlSpeechMessage,
  classifyRealtimeVoiceAgentControlText,
  controlRealtimeVoiceAgentRun,
  normalizeRealtimeVoiceAgentControlMode,
  parseRealtimeVoiceAgentControlToolArgs,
  REALTIME_VOICE_AGENT_CONTROL_MODES,
  REALTIME_VOICE_AGENT_CONTROL_TOOL,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  resolveRealtimeVoiceAgentControlIntent,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlMode,
  type RealtimeVoiceAgentControlIntent,
  type RealtimeVoiceAgentControlProviderResult,
  type RealtimeVoiceAgentControlResult,
} from "../talk/agent-run-control.js";
export {
  resolveRealtimeVoiceFastContextConsult,
  type RealtimeVoiceFastContextConfig,
  type RealtimeVoiceFastContextConsultResult,
  type RealtimeVoiceFastContextLabels,
} from "../talk/fast-context-runtime.js";
export {
  canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider,
  listRealtimeVoiceProviders,
  normalizeRealtimeVoiceProviderId,
} from "../talk/provider-registry.js";
export {
  resolveConfiguredRealtimeVoiceProvider,
  type ResolvedRealtimeVoiceProvider,
  type ResolveConfiguredRealtimeVoiceProviderParams,
} from "../talk/provider-resolver.js";
export {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceAudioSink,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSessionParams,
  type RealtimeVoiceMarkStrategy,
} from "../talk/session-runtime.js";
export {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceSessionHarness,
} from "../talk/realtime-session-harness.js";
export {
  extendRealtimeVoiceOutputEchoSuppression,
  getRealtimeVoiceBridgeEventHealth,
  getRealtimeVoiceTranscriptHealth,
  isLikelyRealtimeVoiceAssistantEchoTranscript,
  recordRealtimeVoiceBridgeEvent,
  recordRealtimeVoiceTranscript,
  type RealtimeVoiceBridgeEventHealth,
  type RealtimeVoiceBridgeEventLogEntry,
  type RealtimeVoiceTranscriptEntry,
  type RealtimeVoiceTranscriptHealth,
} from "../talk/session-log-runtime.js";
export {
  calculateMulawRms,
  createSpeechThresholdGate,
  readPcm16AudioStats,
  type AudioEnergyStats,
} from "../talk/audio-energy.js";
export {
  convertPcmToMulaw8k,
  mulawToPcm,
  pcmToMulaw,
  resamplePcm,
  resamplePcmTo8k,
} from "../talk/audio-codec.js";
