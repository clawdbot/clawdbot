/**
 * @deprecated Compatibility alias. Import memory event helpers from
 * `openclaw/plugin-sdk/memory-host-events` instead.
 */

export {
  appendMemoryHostEvent,
  MEMORY_HOST_EVENT_LOG_RELATIVE_PATH,
  readMemoryHostEventRecords,
  readMemoryHostEvents,
  resolveMemoryHostEventLogPath,
} from "../memory-host-sdk/events.js";
export type {
  MemoryDreamOutcome,
  MemoryHostDreamCompletedEvent,
  MemoryHostEvent,
  MemoryHostEventRecord,
  MemoryHostPromotionAppliedEvent,
  MemoryHostRecallRecordedEvent,
  MemoryHostRecallSkippedEvent,
} from "../memory-host-sdk/events.js";
