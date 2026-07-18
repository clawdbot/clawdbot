// Best-effort Teams web selectors. data-tid values are preferred because Teams
// uses them extensively; every flow still needs validation against a live tenant.
export const TEAMS_MEETING_SELECTORS = {
  continueInBrowser: [
    '[data-tid="joinOnWeb"]',
    '[data-tid="joinOnWebButton"]',
    'button[data-tid="continue-on-browser"]',
  ],
  guestName: [
    'input[data-tid="prejoin-display-name-input"]',
    '[data-tid="prejoin-display-name-input"] input',
    'input[data-tid="guest-name-input"]',
  ],
  join: [
    'button[data-tid="prejoin-join-button"]',
    '[data-tid="prejoin-join-button"] button',
    'button[data-tid="join-now"]',
    'button[data-tid="join-button"]',
  ],
  microphone: [
    'button[data-tid="toggle-mute"]',
    '[data-tid="toggle-mute"] button',
    'button[data-tid="microphone-button"]',
  ],
  camera: [
    'button[data-tid="toggle-video"]',
    '[data-tid="toggle-video"] button',
    'button[data-tid="camera-button"]',
  ],
  deviceSettings: [
    'button[data-tid="prejoin-device-settings-button"]',
    'button[data-tid="device-settings-button"]',
    'button[data-tid="audio-device-settings-button"]',
  ],
  microphoneDevice: [
    '[data-tid="microphone-select"]',
    '[data-tid="audio-device-input"]',
    '[data-tid="device-settings-microphone"] [role="combobox"]',
    'select[data-tid="microphone-select"]',
  ],
  selectedMicrophoneDevice: ["option:checked", '[role="option"][aria-selected="true"]'],
  audioDeviceOptions: ["option", '[role="option"]'],
  leave: [
    'button[data-tid="call-hangup"]',
    '[data-tid="call-hangup"] button',
    'button[data-tid="hangup-button"]',
    'button[data-tid="call-hangup-button"]',
  ],
  leaveConfirmation: [
    'button[data-tid="confirm-leave-button"]',
    'button[data-tid="leave-meeting-confirm"]',
    'button[data-tid="leave-call-confirm"]',
  ],
  postCall: [
    '[data-tid="call-ended-screen"]',
    '[data-tid="post-call-screen"]',
    'button[data-tid="prejoin-rejoin-button"]',
  ],
  lobby: ['[data-tid="lobby-screen"]', '[data-tid="lobby-waiting-screen"]'],
  signIn: [
    'button[data-tid="signin-button"]',
    'button[data-tid="sign-in-button"]',
    '[data-tid="auth-signin"]',
  ],
  permissionPrompt: [
    '[data-tid="device-permission-prompt"]',
    '[data-tid="media-permission-prompt"]',
    '[data-tid="browser-permission-error"]',
  ],
} as const;
