export const mediaExtensionTestRoots = [
  "extensions/alibaba",
  "extensions/deepgram",
  "extensions/elevenlabs",
  "extensions/fal",
  "extensions/image-generation-core",
  "extensions/runway",
  "extensions/talk-voice",
  "extensions/video-generation-core",
  "extensions/vydra",
  "extensions/xiaomi",
];

export function isMediaExtensionRoot(root) {
  return mediaExtensionTestRoots.includes(root);
}
