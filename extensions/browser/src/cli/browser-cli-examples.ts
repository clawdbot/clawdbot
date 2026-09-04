/**
 * Help examples shown by the Browser CLI root command.
 */
/** Core Browser CLI examples for lifecycle and inspection commands. */
export const browserCoreExamples = [
  "openclaw browser status",
  "openclaw browser start",
  "openclaw browser start --headless",
  "openclaw browser stop",
  "openclaw browser tabs",
  "openclaw browser open https://example.com",
  "openclaw browser focus abcd1234",
  "openclaw browser close abcd1234",
  "openclaw browser screenshot",
  "openclaw browser screenshot --full-page",
  "openclaw browser screenshot --ref 12",
  "openclaw browser snapshot",
  "openclaw browser snapshot --format aria --limit 200",
  "openclaw browser snapshot --efficient",
  "openclaw browser snapshot --labels",
];

/** Browser CLI examples for interaction/action commands. */
export const browserActionExamples = [
  "openclaw browser navigate https://example.com",
  "openclaw browser resize 1280 720",
  "openclaw browser click 12 --double",
  "openclaw browser click-coords 120 340",
  'openclaw browser type 23 "hello" --submit',
  "openclaw browser press Enter",
  "openclaw browser hover 44",
  "openclaw browser drag 10 11",
  "openclaw browser select 9 OptionA OptionB",
  "openclaw browser upload /tmp/openclaw/uploads/file.pdf",
  "openclaw browser upload media://inbound/file.pdf",
  'openclaw browser fill --fields \'[{"ref":"1","value":"Ada"}]\'',
  "openclaw browser dialog --accept",
  'openclaw browser wait --text "Done"',
  "openclaw browser evaluate --fn '(el) => el.textContent' --ref 7",
  "openclaw browser evaluate --fn 'const title = document.title; return title;'",
  "openclaw browser console --level error",
  "openclaw browser pdf",
  "openclaw browser batch --actions-file plan.json",
  'openclaw browser batch --actions \'[{"kind":"wait","timeMs":500},{"kind":"click","ref":"12"},{"kind":"type","ref":"23","text":"hello"}]\'',
  "openclaw browser batch --actions-file plan.json --continue",
];
