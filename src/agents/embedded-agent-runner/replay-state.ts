/**
 * Tracks whether an embedded run can be replayed after compaction or retry.
 */
export type EmbeddedRunReplayState = {
  replayInvalid: boolean;
  hadPotentialSideEffects: boolean;
};

/** Serializable replay metadata stored with run results. */
export type EmbeddedRunReplayMetadata = {
  hadPotentialSideEffects: boolean;
  replaySafe: boolean;
};

/** Creates a normalized replay state from partial caller metadata. */
export function createEmbeddedRunReplayState(
  state?: Partial<EmbeddedRunReplayState>,
): EmbeddedRunReplayState {
  return {
    replayInvalid: state?.replayInvalid === true,
    hadPotentialSideEffects: state?.hadPotentialSideEffects === true,
  };
}

/** Merges replay state monotonically so unsafe observations cannot be cleared accidentally. */
export function mergeEmbeddedRunReplayState(
  current: EmbeddedRunReplayState,
  next?: Partial<EmbeddedRunReplayState>,
): EmbeddedRunReplayState {
  if (!next) {
    return current;
  }
  return {
    replayInvalid: current.replayInvalid || next.replayInvalid === true,
    hadPotentialSideEffects:
      current.hadPotentialSideEffects || next.hadPotentialSideEffects === true,
  };
}

/** Applies result metadata to the current replay state. */
export function observeReplayMetadata(
  current: EmbeddedRunReplayState,
  metadata?: EmbeddedRunReplayMetadata | null,
): EmbeddedRunReplayState {
  if (!metadata) {
    // Missing metadata means the caller cannot prove replay safety. Treat it as side-effectful so
    // compaction/retry code avoids duplicating actions after an opaque run.
    return mergeEmbeddedRunReplayState(current, {
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
  }
  return mergeEmbeddedRunReplayState(current, {
    replayInvalid: !metadata.replaySafe,
    hadPotentialSideEffects: metadata.hadPotentialSideEffects,
  });
}

/** Converts internal replay state into the compact metadata persisted with run results. */
export function replayMetadataFromState(state: EmbeddedRunReplayState): EmbeddedRunReplayMetadata {
  return {
    hadPotentialSideEffects: state.hadPotentialSideEffects,
    replaySafe: !state.replayInvalid && !state.hadPotentialSideEffects,
  };
}
