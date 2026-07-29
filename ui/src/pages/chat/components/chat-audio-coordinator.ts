let activeAudio: HTMLMediaElement | null = null;

/** Claims the page's audio slot and pauses any previously playing chat audio. */
export function claimChatAudioPlayback(media: HTMLMediaElement): void {
  if (activeAudio === media) {
    return;
  }
  activeAudio?.pause();
  activeAudio = media;
}

export function releaseChatAudioPlayback(media: HTMLMediaElement): void {
  if (activeAudio === media) {
    activeAudio = null;
  }
}
