import { handleToolExecutionEnd } from "./embedded-agent-subscribe.handlers.tools.completion.js";
import { handleToolExecutionUpdate } from "./embedded-agent-subscribe.handlers.tools.progress.js";
import {
  cleanupRunToolStartData,
  countActiveToolExecutions,
  handleToolExecutionStart,
} from "./embedded-agent-subscribe.handlers.tools.start.js";
/**
 * Handles embedded-agent tool execution events and turns them into channel UI,
 * replay state, hook calls, approval prompts, media queues, and agent-event
 * telemetry.
 */

export {
  cleanupRunToolStartData,
  countActiveToolExecutions,
  handleToolExecutionEnd,
  handleToolExecutionStart,
  handleToolExecutionUpdate,
};
