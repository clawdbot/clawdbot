import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";

export function zoomMeetingStatusCallSource(): string {
  return MeetingPlatformAdapter.createStatusCallSource({
    platform: {
      audioOutputElementIdPrefix: "openclaw-zoom-audio-output-",
      displayName: "Zoom",
      globals: {
        audioOutputs: "__openclawZoomAudioOutputs",
        captions: "__openclawZoomCaptions",
        meeting: "__openclawZoomMeeting",
      },
      manualActionReasonPrefix: "zoom",
    },
    captionEnableSource: `if (!captionsFinalized && canMutateSession && inCall && !captionsEnabledNow) {
      let captionButton = first(selectors.captions);
      if (!captionButton) {
        (first(selectors.moreActions) || findTextButton(/^more$/i))?.click?.();
        await waitForUi();
        captionButton = first(selectors.captions);
      }
      if (captionButton) {
        const captionLabel = label(captionButton);
        const alreadyEnabled = captionButton.getAttribute?.("aria-checked") === "true" ||
          /hide (?:live )?captions|turn off captions/i.test(captionLabel) ||
          Boolean(firstRaw(selectors.captionsOff));
        if (!alreadyEnabled) {
          captionButton.click();
          await waitForUi();
          const showCaptions = first(selectors.captions);
          if (showCaptions && showCaptions !== captionButton && /show captions/i.test(label(showCaptions))) {
            showCaptions.click();
            await waitForUi();
          }
          const saveLanguage = findTextButton(/^save$/i);
          if (saveLanguage && /caption language/i.test(text(document.body))) {
            saveLanguage.click();
            await waitForUi();
          }
        }
        const currentCaptionButton = first(selectors.captions) || captionButton;
        const currentLabel = label(currentCaptionButton);
        captionsEnabledNow = currentCaptionButton.getAttribute?.("aria-checked") === "true" ||
          /hide (?:live )?captions|turn off captions/i.test(currentLabel) ||
          Boolean(firstRaw(selectors.captionRenderer)) ||
          Boolean(firstRaw(selectors.captionsOff));
        if (captionsEnabledNow && !alreadyEnabled) {
          notes.push("Enabled Zoom live captions for transcript capture.");
        }
      }
    }`,
    extraResultSource: "meetingEnded,",
  });
}
