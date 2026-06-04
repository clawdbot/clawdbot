/**
 * Runtime SDK subpath for skill snapshot invalidation and refresh listeners.
 */
export {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
  shouldRefreshSnapshotForVersion,
  type SkillsChangeEvent,
} from "../skills/runtime/refresh-state.js";
