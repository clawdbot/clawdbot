const TEAMS_MEETING_CAPTION_SETTLE_MS = 1_000;
const TEAMS_MEETING_TRANSCRIPT_MAX_LINES = 500;

export function teamsMeetingStatusCallSource(): string {
  return `  let audioOutputRouted;
  let audioOutputDeviceLabel;
  let audioOutputRouteError;
  let audioOutputRouteRetryable = false;
  if (inCall && allowMicrophone && navigator.mediaDevices?.enumerateDevices) {
    const media = [...document.querySelectorAll("audio, video")].filter(
      (element) =>
        typeof element.setSinkId === "function" &&
        !String(element.id || "").startsWith("openclaw-teams-audio-output-"),
    );
    if (media.length > 0) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const output = devices.find((device) => device.kind === "audiooutput" && isBlackHole(device.label));
        if (output?.deviceId) {
          const routeErrors = [];
          const liveStream = (element) =>
            element.srcObject?.getAudioTracks?.().some((track) => track.readyState === "live")
              ? element.srcObject
              : undefined;
          const allBridgeEntries = Array.isArray(window.__openclawTeamsAudioOutputs)
            ? window.__openclawTeamsAudioOutputs
            : [];
          const retainedBridgeEntries = allBridgeEntries.filter((entry) => !bridgeOwnedBySession(entry));
          const previousBridgeEntries = allBridgeEntries.filter(bridgeOwnedBySession);
          const originalMuteBySource = new Map(previousBridgeEntries.flatMap((entry) =>
            bridgeSources(entry).flatMap((source) =>
              source?.element ? [[source.element, Boolean(source.muted)]] : []
            )
          ));
          const bridgedElements = new Set(previousBridgeEntries.flatMap((entry) =>
            bridgeSources(entry).map((source) => source?.element).filter(Boolean)
          ));
          const routeCandidates = media
            .map((element) => ({ element, stream: liveStream(element) }))
            // Teams mutes local/self-view and intentionally suppressed playback. Preserve
            // that product decision; only our own already-bridged source stays eligible.
            .filter((entry) => !entry.element.muted || bridgedElements.has(entry.element));
          // The self-view often exists before Teams attaches remote playback. With the
          // required output present, an all-filtered list is still a transient DOM state.
          if (routeCandidates.length === 0) audioOutputRouteRetryable = true;
          if (canMutateSession) {
            for (const { element } of routeCandidates) {
              if (!originalMuteBySource.has(element)) {
                originalMuteBySource.set(element, Boolean(element.muted));
              }
              // Sink changes are asynchronous. Silence the physical output until either
              // the source or its fallback bridge is confirmed on BlackHole.
              element.muted = true;
            }
          }
          const currentSources = new Set(routeCandidates.map((entry) => entry.element));
          const bridgeEntries = previousBridgeEntries.filter((entry) =>
            entry?.source &&
            entry?.stream === liveStream(entry.source) &&
            entry?.bridge?.isConnected &&
            currentSources.has(entry.source)
          );
          const suspendedBySource = new Map();
          for (const entry of previousBridgeEntries) {
            if (bridgeEntries.includes(entry)) continue;
            for (const source of bridgeSources(entry)) {
              if (
                !source?.element ||
                source.muted ||
                !bridgeSourceMatches(source.element, source)
              ) continue;
              const sourceStillPresent = currentSources.has(source.element);
              const detachedLiveSource = !sourceStillPresent && Boolean(liveStream(source.element));
              if (!sourceStillPresent && !detachedLiveSource) continue;
              suspendedBySource.set(source.element, {
                detached: detachedLiveSource,
                sessionId: entry.sessionId || sessionId,
                source: source.element,
                sourceMuted: false,
                sourceUrl: mediaSourceUrl(source.element) || source.url,
                stream: source.element.srcObject,
                suspended: true,
              });
            }
          }
          if (canMutateSession) {
            // One bridge owns one Teams playback element. Stream or element replacement
            // retires that bridge so it cannot keep playing or satisfy route verification.
            previousBridgeEntries.filter((entry) => !bridgeEntries.includes(entry)).forEach((entry) => {
              for (const source of bridgeSources(entry)) {
                if (
                  !source?.element ||
                  suspendedBySource.has(source.element) ||
                  currentSources.has(source.element)
                ) continue;
                restoreAudioBridgeSource(source);
              }
              // Reused current elements stay silent until this pass confirms their
              // replacement source; unrelated exact sources were restored above.
              retireAudioBridge(entry, false);
            });
          }
          const routed = [];
          for (const { element, stream } of routeCandidates) {
            let entry = bridgeEntries.find((candidate) => candidate.source === element);
            let elementRouted = element.sinkId === output.deviceId;
            let directRouteError;
            if (canMutateSession && !elementRouted) {
              try {
                await element.setSinkId(output.deviceId);
                elementRouted = element.sinkId === output.deviceId;
              } catch (error) {
                directRouteError = {
                  message: error?.message || String(error),
                  retryable: error?.name === "AbortError",
                };
              }
            }
            if (elementRouted && entry && canMutateSession) {
              const bridgedIndex = bridgeEntries.indexOf(entry);
              if (bridgedIndex >= 0) {
                const [bridged] = bridgeEntries.splice(bridgedIndex, 1);
                retireAudioBridge(bridged);
                entry = undefined;
              }
            }
            // Direct sink routing is valid for src/MediaSource and pre-attachment elements.
            // A live MediaStream is required only when the hidden bridge fallback is needed.
            if (elementRouted) {
              if (canMutateSession && originalMuteBySource.has(element)) {
                element.muted = originalMuteBySource.get(element);
              }
              suspendedBySource.delete(element);
              routed.push(true);
              continue;
            }
            if (!stream) {
              const hasLoadedPlaybackSource = Number(element.readyState) > 0;
              routed.push(false);
              if (hasLoadedPlaybackSource && directRouteError) routeErrors.push(directRouteError);
              if (!hasLoadedPlaybackSource) audioOutputRouteRetryable = true;
              if (canMutateSession && originalMuteBySource.get(element) === false) {
                // Teams may attach the remote MediaStream after creating its media element.
                // Keep it silent until a later serialized status poll routes that source.
                suspendedBySource.set(element, {
                  sessionId,
                  pending: true,
                  source: element,
                  sourceMuted: false,
                  sourceUrl: mediaSourceUrl(element),
                  stream: element.srcObject,
                  suspended: true,
                });
              }
              continue;
            }
            if (!elementRouted && stream) {
              if (!entry && canMutateSession) {
                const bridge = document.createElement("audio");
                bridge.id = "openclaw-teams-audio-output-" + bridgeEntries.length;
                bridge.autoplay = false;
                bridge.hidden = true;
                bridge.srcObject = stream;
                document.body.appendChild(bridge);
                entry = {
                  bridge,
                  playing: false,
                  sessionId,
                  source: element,
                  sourceMuted: originalMuteBySource.has(element)
                    ? originalMuteBySource.get(element)
                    : Boolean(element.muted),
                  sourceUrl: mediaSourceUrl(element),
                  stream,
                };
                bridgeEntries.push(entry);
                suspendedBySource.delete(element);
              }
              if (entry?.bridge) {
                try {
                  if (canMutateSession) {
                    if (entry.bridge.sinkId !== output.deviceId) {
                      await entry.bridge.setSinkId(output.deviceId);
                    }
                    await entry.bridge.play();
                    entry.playing = true;
                  }
                  elementRouted =
                    entry.bridge.sinkId === output.deviceId && entry.playing === true;
                  if (elementRouted) {
                    suspendedBySource.delete(element);
                    if (canMutateSession && !entry.sourceMuted) element.muted = true;
                  }
                } catch (error) {
                  entry.playing = false;
                  if (canMutateSession) retireAudioBridge(entry, false);
                  routeErrors.push({
                    message: error?.message || String(error),
                    retryable: error?.name === "AbortError",
                  });
                }
              }
            }
            routed.push(elementRouted);
          }
          if (canMutateSession) {
            const nextBridgeEntries = [
              ...retainedBridgeEntries,
              ...bridgeEntries,
              ...suspendedBySource.values(),
            ];
            if (nextBridgeEntries.length > 0) {
              window.__openclawTeamsAudioOutputs = nextBridgeEntries;
            } else {
              delete window.__openclawTeamsAudioOutputs;
            }
          }
          audioOutputRouted = routed.length > 0 && routed.every(Boolean);
          if (canMutateSession && !audioOutputRouted) suspendOwnedAudioBridges();
          if (audioOutputRouted && bridgeEntries.length > 0) {
            notes.push("Routed Teams remote audio to BlackHole 2ch through MediaStream bridges.");
          }
          audioOutputDeviceLabel = output.label || "BlackHole 2ch";
          // An unloaded Teams media element can reject setSinkId before its stream
          // arrives. Keep that state retryable; loaded-source failures are terminal.
          if (!audioOutputRouted && routed.length > 0 && routeErrors.length > 0) {
            audioOutputRouteError = routeErrors[routeErrors.length - 1]?.message;
            audioOutputRouteRetryable = routeErrors.every((error) => error.retryable === true);
          }
        } else {
          audioOutputRouted = false;
          if (canMutateSession) suspendOwnedAudioBridges();
          notes.push("BlackHole 2ch speaker output was not visible to Teams.");
        }
      } catch (error) {
        audioOutputRouted = false;
        audioOutputRouteError = error?.message || String(error);
        if (canMutateSession) suspendOwnedAudioBridges();
      }
      if (!audioOutputRouted && audioOutputRouteError) {
        notes.push("Could not route Teams speaker output to BlackHole 2ch: " + audioOutputRouteError);
      }
    } else {
      audioOutputRouted = false;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const output = devices.find(
          (device) => device.kind === "audiooutput" && isBlackHole(device.label)
        );
        if (output?.deviceId) {
          // Teams can briefly remove every media element during an in-call rerender.
          // Retry only after proving the required output still exists.
          audioOutputRouteRetryable = true;
          audioOutputDeviceLabel = output.label || "BlackHole 2ch";
        } else {
          notes.push("BlackHole 2ch speaker output was not visible to Teams.");
        }
      } catch (error) {
        audioOutputRouteError = error?.message || String(error);
        notes.push("Could not inspect Teams speaker outputs: " + audioOutputRouteError);
      }
      // Suspend ownership until the source returns; call teardown retires it.
      if (canMutateSession) suspendOwnedAudioBridges();
    }
  } else if (inCall && allowMicrophone) {
    audioOutputRouted = false;
    if (canMutateSession) retireOwnedAudioBridges();
  }
  let captioning = false;
  let captionsEnabledAttempted = false;
  let transcriptLines = 0;
  let lastCaptionAt;
  let lastCaptionSpeaker;
  let lastCaptionText;
  let recentTranscript = [];
  const captionState = (() => {
    let active = window.__openclawTeamsCaptions;
    const activeOwnedByRequest = Boolean(
      !active || (sessionId && (!active.sessionId || active.sessionId === sessionId))
    );
    if (!identityVerified) {
      if (identityAwaitingRerender && activeOwnedByRequest) return active;
      if (canMutateSession && activeOwnedByRequest) finalizeOwnedCaptions();
      return undefined;
    }
    if (!activeOwnedByRequest) {
      const replacedPriorOwner = Boolean(
        canMutateSession &&
        active?.sessionId &&
        active.sessionId !== sessionId
      );
      if (replacedPriorOwner) {
        if (priorMeeting?.sessionId === active.sessionId) {
          active.identity ||= priorMeeting.identity;
        }
        finalizeCaptionState(active);
      }
      else if (!canMutateSession || !captureCaptions || active?.finalized !== true) return undefined;
      archiveFinalizedCaptions(active);
      if (active.settleTimer !== undefined) clearTimeout(active.settleTimer);
      active.observer?.disconnect?.();
      delete window.__openclawTeamsCaptions;
      active = undefined;
    }
    if (!captureCaptions) {
      if (!canMutateSession) return undefined;
      if (active?.settleTimer !== undefined) clearTimeout(active.settleTimer);
      active?.observer?.disconnect?.();
      if (active) delete window.__openclawTeamsCaptions;
      return undefined;
    }
    if (!inCall && !active) return undefined;
    if (!active && !canMutateSession) return undefined;
    if (!active) {
      if (active?.settleTimer !== undefined) clearTimeout(active.settleTimer);
      active?.observer?.disconnect?.();
      window.__openclawTeamsCaptions = {
        sessionId,
        identity: expectedIdentity,
        epoch: crypto.randomUUID(),
        enabledAttempted: false,
        observerInstalled: false,
        observer: undefined,
        droppedLines: 0,
        lines: [],
        settled: [],
        settleTimer: undefined,
        visible: [],
      };
    }
    return window.__openclawTeamsCaptions;
  })();
  const normalizeCaption = (speaker, captionText) => {
    if (!captionState) return undefined;
    const clean = String(captionText || "").replace(/\\s+/g, " ").trim();
    const cleanSpeaker = String(speaker || "").replace(/\\s+/g, " ").trim();
    if (!clean) return undefined;
    return { speaker: cleanSpeaker || undefined, text: clean };
  };
  const captionRowIdentity = (row) =>
    // aria-posinset identifies the logical caption item across virtual-list
    // rerenders. DOM ids and data indexes can belong to the recycled element.
    ["aria-posinset"]
      .map((name) => {
        const value = row?.getAttribute?.(name);
        return typeof value === "string" && value.trim()
          ? name + ":" + value.trim()
          : undefined;
      })
      .find(Boolean);
  const sameCaptionUtterance = (prior, current) => {
    if (prior.rowIdentity || current.rowIdentity) {
      return Boolean(
        prior.rowIdentity &&
        current.rowIdentity &&
        prior.rowIdentity === current.rowIdentity
      );
    }
    if (prior.speaker && current.speaker && prior.speaker !== current.speaker) return false;
    return prior.node === current.node;
  };
  const commitCaptionLines = (state, entries) => {
    state.lines.push(...entries.map((entry) => {
      entry.utteranceId ||= crypto.randomUUID();
      return {
        at: entry.at,
        speaker: entry.speaker,
        text: entry.text,
        utteranceId: entry.utteranceId,
      };
    }));
    const excess = state.lines.length - ${TEAMS_MEETING_TRANSCRIPT_MAX_LINES};
    if (excess > 0) {
      state.lines.splice(0, excess);
      state.droppedLines = (state.droppedLines || 0) + excess;
    }
  };
  const sameCaptionRow = (left, right) =>
    right.rowIdentity
      ? left.rowIdentity === right.rowIdentity
      : left.node === right.node;
  const retainSettledCaptionLines = (state, entries) => {
    const settled = [...state.settled];
    for (const entry of entries) {
      const priorIndex = settled.findIndex((candidate) => sameCaptionRow(candidate, entry));
      if (priorIndex >= 0) settled.splice(priorIndex, 1, { ...entry });
      else settled.push({ ...entry });
    }
    const retainedLineIds = new Set(state.lines.map((entry) => entry.utteranceId));
    state.settled = settled.filter((entry) => retainedLineIds.has(entry.utteranceId));
  };
  const scheduleCaptionSettle = () => {
    if (!captionState || captionState.visible.length === 0) return;
    if (captionState.settleTimer !== undefined) clearTimeout(captionState.settleTimer);
    const pendingState = captionState;
    pendingState.settleTimer = setTimeout(() => {
      if (window.__openclawTeamsCaptions !== pendingState) return;
      commitCaptionLines(pendingState, pendingState.visible);
      retainSettledCaptionLines(pendingState, pendingState.visible);
      pendingState.visible = [];
      pendingState.settleTimer = undefined;
    }, ${TEAMS_MEETING_CAPTION_SETTLE_MS});
  };
  const captionCaptureMatchesCurrentMeeting = () => {
    if (
      !captionState ||
      captionState.finalized === true ||
      window.__openclawTeamsCaptions !== captionState
    ) return false;
    const observedIdentity = meetingIdentity(location.href);
    const observedMeeting = window.__openclawTeamsMeeting;
    const identityConflicts = Boolean(
      observedIdentity && expectedIdentity && observedIdentity !== expectedIdentity
    );
    const sessionConflicts = Boolean(
      observedMeeting?.sessionId && sessionId && observedMeeting.sessionId !== sessionId
    );
    if (identityConflicts || sessionConflicts) {
      // The observer outlives Teams SPA navigation. Freeze the old buffer before
      // any caption nodes from the replacement meeting can be attributed to it.
      finalizeOwnedCaptions();
      return false;
    }
    if (observedIdentity === expectedIdentity) return true;
    const observedMarkerAgeMs = Date.now() - (observedMeeting?.verifiedAt || 0);
    const observedAwaitingRerender = Boolean(
      !observedIdentity &&
      observedMeeting?.identity === expectedIdentity &&
      (!observedMeeting.sessionId || !sessionId || observedMeeting.sessionId === sessionId) &&
      observedMeeting.inCallControl?.isConnected === false &&
      observedMeeting.inCallUrl === location.href &&
      observedMarkerAgeMs >= 0 &&
      observedMarkerAgeMs < 5_000
    );
    if (observedAwaitingRerender) return true;
    return Boolean(
      observedMeeting?.identity === expectedIdentity &&
      (!observedMeeting.sessionId || !sessionId || observedMeeting.sessionId === sessionId) &&
      observedMeeting.inCallControl?.isConnected !== false &&
      observedMeeting.inCallUrl === location.href
    );
  };
  const scrapeCaptions = (mutations = []) => {
    if (!captionCaptureMatchesCurrentMeeting()) return;
    const content = firstRaw(selectors.captionContent);
    const rows = content
      ? selectors.captionRows.flatMap((selector) => [...content.querySelectorAll(selector)])
      : [];
    captionState.settled = Array.isArray(captionState.settled) ? captionState.settled : [];
    const removedNodes = mutations.flatMap((mutation) => [...(mutation.removedNodes || [])]);
    const rowWasRemoved = (entry) => removedNodes.some((node) =>
      node === entry.node || node?.contains?.(entry.node)
    );
    const removedVisible = captionState.visible.filter(rowWasRemoved);
    if (removedVisible.length > 0) {
      if (captionState.settleTimer !== undefined) clearTimeout(captionState.settleTimer);
      captionState.settleTimer = undefined;
      captionState.visible = captionState.visible.filter((entry) => !rowWasRemoved(entry));
      commitCaptionLines(captionState, removedVisible);
      retainSettledCaptionLines(captionState, removedVisible);
    }
    const retainedLineIds = new Set(captionState.lines.map((entry) => entry.utteranceId));
    captionState.settled = captionState.settled.filter((entry) =>
      entry.rowIdentity
        ? retainedLineIds.has(entry.utteranceId)
        : !rowWasRemoved(entry) && rows.some((row) => sameCaptionRow(entry, {
            node: row,
            rowIdentity: captionRowIdentity(row),
          }))
    );
    const parsedRows = rows.flatMap((row) => {
      const speaker = text(firstWithin(row, selectors.captionAuthor));
      const captionText = text(firstWithin(row, selectors.captionText));
      const parsed = normalizeCaption(speaker, captionText);
      if (!parsed) return [];
      const current = { ...parsed, node: row, rowIdentity: captionRowIdentity(row) };
      const settledIndex = captionState.settled.findIndex((entry) =>
        sameCaptionRow(entry, current)
      );
      const settled = settledIndex >= 0 ? captionState.settled[settledIndex] : undefined;
      if (
        settled &&
        settled.text === current.text &&
        (settled.speaker || "") === (current.speaker || "")
      ) return [];
      if (settled?.rowIdentity && settled.rowIdentity === current.rowIdentity) {
        const committed = captionState.lines.find((entry) =>
          entry.utteranceId === settled.utteranceId
        );
        if (committed) {
          committed.speaker = current.speaker || committed.speaker;
          committed.text = current.text;
        }
        captionState.settled.splice(settledIndex, 1, {
          ...settled,
          ...current,
          speaker: current.speaker || settled.speaker,
        });
        return [];
      }
      if (settledIndex >= 0) captionState.settled.splice(settledIndex, 1);
      return [current];
    });
    if (parsedRows.length === 0) {
      if (captionState.visible.length > 0 && captionState.settleTimer === undefined) {
        scheduleCaptionSettle();
      }
      return;
    }
    const unmatchedPrevious = [...captionState.visible];
    const nextVisible = [];
    const now = Date.now();
    let captionChanged = false;
    for (const row of parsedRows) {
      const priorIndex = unmatchedPrevious.findIndex((candidate) =>
        row.rowIdentity
          ? candidate.rowIdentity === row.rowIdentity
          : candidate.node === row.node
      );
      const candidate = priorIndex >= 0 ? unmatchedPrevious[priorIndex] : undefined;
      const prior = candidate && sameCaptionUtterance(candidate, row)
        ? unmatchedPrevious.splice(priorIndex, 1)[0]
        : undefined;
      if (prior) {
        captionChanged ||=
          prior.text !== row.text ||
          prior.speaker !== row.speaker ||
          prior.node !== row.node;
        prior.speaker = row.speaker || prior.speaker;
        prior.text = row.text;
        prior.node = row.node;
        prior.rowIdentity = row.rowIdentity || prior.rowIdentity;
        prior.seenAt = now;
        nextVisible.push(prior);
      } else {
        captionChanged = true;
        nextVisible.push({
          at: new Date().toISOString(),
          node: row.node,
          rowIdentity: row.rowIdentity,
          seenAt: now,
          speaker: row.speaker,
          text: row.text,
        });
      }
    }
    captionChanged ||= unmatchedPrevious.length > 0;
    commitCaptionLines(captionState, unmatchedPrevious);
    retainSettledCaptionLines(captionState, unmatchedPrevious);
    captionState.visible = nextVisible;
    // Identity-less rows stay mutable while rendered; removal is their only
    // reliable utterance boundary. Stable logical rows may settle on quiet.
    if (
      (captionChanged || captionState.settleTimer === undefined) &&
      captionState.visible.every((entry) => entry.rowIdentity)
    ) {
      scheduleCaptionSettle();
    }
  };
  if (captionState) {
    const captionsFinalized = captionState.finalized === true;
    let captionsEnabledNow = captionsFinalized
      ? Boolean(captionState.enabledAttempted)
      : Boolean(firstRaw(selectors.captionRenderer) || firstRaw(selectors.captionsOff));
    if (!captionsFinalized && canMutateSession && inCall && !captionsEnabledNow) {
      let captionButton = first(selectors.captions);
      if (!captionButton) {
        first(selectors.moreActions)?.click?.();
        await waitForUi();
        captionButton = first(selectors.captions);
      }
      if (captionButton) {
        const captionLabel = label(captionButton);
        const alreadyEnabled = captionButton.getAttribute?.("aria-checked") === "true" ||
          /hide live captions|turn off captions/i.test(captionLabel) ||
          Boolean(firstRaw(selectors.captionsOff));
        if (!alreadyEnabled) {
          captionButton.click();
          await waitForUi();
        }
        const currentLabel = label(captionButton);
        captionsEnabledNow = captionButton.getAttribute?.("aria-checked") === "true" ||
          /hide live captions|turn off captions/i.test(currentLabel) ||
          Boolean(firstRaw(selectors.captionRenderer)) ||
          Boolean(firstRaw(selectors.captionsOff));
        if (captionsEnabledNow && !alreadyEnabled) {
          notes.push("Enabled Teams live captions for transcript capture.");
        }
      }
    }
    if (!captionsFinalized && canMutateSession) captionState.enabledAttempted = captionsEnabledNow;
    captionsEnabledAttempted = Boolean(captionState.enabledAttempted);
    if (!captionsFinalized && canMutateSession && inCall && !captionState.observerInstalled) {
      captionState.observerInstalled = true;
      captionState.observer = new MutationObserver(scrapeCaptions);
      captionState.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      notes.push("Installed Teams live-caption observer.");
    }
    if (!captionsFinalized && canMutateSession && inCall) scrapeCaptions();
    const allLines = [...captionState.lines, ...captionState.visible];
    const lines = allLines.slice(-${TEAMS_MEETING_TRANSCRIPT_MAX_LINES});
    const last = lines[lines.length - 1];
    captioning = captionsEnabledNow;
    transcriptLines = (captionState.droppedLines || 0) + allLines.length;
    lastCaptionAt = last?.at;
    lastCaptionSpeaker = last?.speaker;
    lastCaptionText = last?.text;
    recentTranscript = lines.slice(-5).map((entry) => ({
      at: entry.at,
      speaker: entry.speaker,
      text: entry.text,
    }));
  }
  if (inCall && allowMicrophone && !manualActionReason) {
    if (audioInputRouted !== true || audioOutputRouted !== true) {
      manualActionReason = "teams-audio-choice-required";
      manualActionMessage = "Verify BlackHole 2ch is selected as both the Teams microphone and speaker before starting talk-back.";
    } else if (micMuted !== false) {
      manualActionReason = "teams-microphone-required";
      manualActionMessage = "Unmute the Teams microphone and verify the microphone control shows it is on before starting talk-back.";
    }
  }
  return JSON.stringify({
    clickedContinueInBrowser: Boolean(continueInBrowser),
    clickedJoin,
    inCall,
    micMuted,
    cameraOff,
    lobbyWaiting,
    captionCaptureRequested: captureCaptions,
    captioning,
    captionsEnabledAttempted,
    transcriptLines,
    lastCaptionAt,
    lastCaptionSpeaker,
    lastCaptionText,
    recentTranscript,
    audioInputRouted,
    audioInputDeviceLabel,
    audioInputRouteError,
    audioOutputRouted,
    audioOutputDeviceLabel,
    audioOutputRouteError,
    audioOutputRouteRetryable,
    manualActionRequired: Boolean(manualActionReason),
    manualActionReason,
    manualActionMessage,
    title: document.title,
    url: location.href,
    notes,
  });
}`;
}
