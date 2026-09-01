type PlaybackTranscodeTestApi = {
  getPlaybackTranscodeJobs(): Promise<void>[];
};

function getTestApi(): PlaybackTranscodeTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.playbackTranscodeTestApi")
  ];
  if (!api) {
    throw new Error("playback transcode test API is unavailable");
  }
  return api as PlaybackTranscodeTestApi;
}

export async function waitForPlaybackTranscodeJobsForTest(mode: "next" | "all"): Promise<number> {
  const jobs = getTestApi().getPlaybackTranscodeJobs();
  if (jobs.length === 0) {
    throw new Error("No active playback transcode jobs");
  }
  await (mode === "next" ? Promise.race(jobs) : Promise.all(jobs));
  return jobs.length;
}
