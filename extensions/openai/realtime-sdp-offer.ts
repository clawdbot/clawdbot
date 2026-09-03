const MAX_SDP_LINES = 4_096;
const MAX_SDP_LINE_BYTES = 4_096;
const MAX_MEDIA_SECTIONS = 8;

export function assertOpenAIRealtimeAudioOnlyOffer(sdp: string): void {
  const lines = sdp.split(/\r\n|\n|\r/u);
  if (lines.length > MAX_SDP_LINES) {
    throw new Error("OpenAI Realtime SDP offer has too many lines");
  }
  let mediaSections = 0;
  let activeAudioSections = 0;
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_SDP_LINE_BYTES) {
      throw new Error("OpenAI Realtime SDP offer line is too large");
    }
    if (!line.startsWith("m=")) {
      continue;
    }
    if (++mediaSections > MAX_MEDIA_SECTIONS) {
      throw new Error("OpenAI Realtime SDP offer has too many media sections");
    }
    const match = /^m=([A-Za-z0-9-]+)\s+(\d+)(?:\/\d+)?(?:\s|$)/u.exec(line);
    if (!match?.[1] || !match[2]) {
      throw new Error("OpenAI Realtime SDP offer has an invalid media section");
    }
    const media = match[1].toLowerCase();
    const active = Number(match[2]) !== 0;
    if (media === "audio") {
      activeAudioSections += Number(active);
    } else if (media !== "application" || active) {
      throw new Error(`OpenAI Realtime Gateway control does not support ${media} media`);
    }
  }
  if (activeAudioSections === 0) {
    throw new Error("OpenAI Realtime Gateway control requires active audio media");
  }
}
