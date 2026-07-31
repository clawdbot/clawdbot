// Zoom Web App selectors validated against the live guest surface on 2026-07-18.
// Prefer Zoom-owned ids and accessibility labels; text remains the fallback where
// the app-launch and nested captions menus expose no stable product identifier.
export const ZOOM_MEETING_SELECTORS = {
  continueInBrowser: [],
  guestName: ["input#input-for-name"],
  join: ["button.preview-join-button"],
  microphone: [
    "button#preview-audio-control-button",
    'button[aria-label="mute my microphone" i]',
    'button[aria-label="unmute my microphone" i]',
  ],
  camera: ["button#preview-video-control-button", "button.send-video-container__btn"],
  deviceSettings: ['button[aria-label="More audio controls" i]'],
  microphoneDevice: ['[aria-label*="microphone" i][role="combobox"]'],
  microphoneDeviceMenu: [".audio-option-menu__pop-menu", '[role="listbox"]', '[role="menu"]'],
  selectedMicrophoneDevice: [
    'a[role="button"][aria-label^="Select a microphone" i][aria-label$="selected" i]',
    "option:checked",
    '[role="option"][aria-selected="true"]',
    '[role="menuitemradio"][aria-checked="true"]',
  ],
  audioDeviceOptions: [
    'a[role="button"][aria-label^="Select a microphone" i]',
    "option",
    '[role="option"]',
    '[role="menuitemradio"]',
  ],
  leave: ['button[aria-label="Leave" i]'],
  leaveConfirmation: [
    "button.leave-meeting-options__btn",
    "button.zm-btn--danger",
    'button[aria-label="Leave Meeting" i]',
  ],
  postCall: [".meeting-ended", ".post-meeting", ".leave-meeting-page"],
  lobby: [".waiting-room-container", '[class*="waiting-room"]', '[class*="waitingRoom"]'],
  signIn: ['a[href*="/signin"]', 'button[aria-label*="sign in" i]'],
  passcode: [
    'input[type="password"]',
    'input[id*="passcode" i]',
    'input[name*="passcode" i]',
    'input[aria-label*="passcode" i]',
  ],
  captcha: [
    'iframe[src*="recaptcha" i]',
    'iframe[title*="captcha" i]',
    ".g-recaptcha",
    "[data-sitekey]",
    '[class*="captcha" i]',
  ],
  permissionPrompt: [".pepc-permission-dialog"],
  moreActions: ["button.more-button", ".footer-more-button button"],
  captions: [
    'a[aria-label*="Show Captions" i]',
    'a[aria-label="Captions" i]',
    '[role="button"][aria-label="Captions" i]',
  ],
  captionsOff: ['a[aria-label*="Hide Captions" i]'],
  captionRenderer: [".live-transcription-subtitle__box"],
  captionContent: ["body"],
  captionRows: ["#live-transcription-subtitle"],
  captionAuthor: [
    ".zmu-data-selector-item__icon",
    ".live-transcription-subtitle__speaker",
    '[class*="transcription"][class*="speaker"]',
  ],
  captionText: [
    ".live-transcription-subtitle__item",
    ".live-transcription-subtitle__text",
    '[class*="transcription"][class*="text"]',
    ".live-transcription-subtitle__box",
  ],
} as const;
