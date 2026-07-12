# App Review Notes

Use these steps to exercise the live OpenClaw iOS App Review Gateway.

## Demo Account / Setup

Use the OpenClaw iOS app with the live review Gateway setup code included in
the `Notes` field of this App Review submission.

The setup code is a single generated code string. It already contains the public
Gateway host and setup credential.

## Setup Walkthrough

1. Open the OpenClaw app.
2. Tap `Continue`.
3. On `Connect Gateway`, tap `Set Up Manually`.
4. In the `Setup Code` section, tap the `Paste setup code` field.
5. Paste the setup code string from the App Review submission `Notes` field.
6. Tap `Apply Setup Code`.
7. If `Trust and connect` appears, tap `Trust and connect`.
8. Wait for the `Connected` screen.
9. On `Connected`, tap `Open OpenClaw`.
10. Confirm the `Control` screen shows `Gateway Online`.
11. Tap `Settings`.
12. Tap `Approvals`.
13. Tap `Open Notifications`.
14. Tap `Enable Notifications`.
15. On `Enable OpenClaw Hosted Push Relay?`, tap `Continue`.
16. If iOS asks whether OpenClaw may send notifications, tap `Allow`.
17. Confirm `Notifications` shows `Enabled`.

## Chat

1. Tap the `Chat` tab.
2. Tap the text field labeled `Message main...`.
3. Send this exact message:

```text
Start Apple review checklist.
```

Expected result: the assistant replies with the available App Review demos.

## Approval Demo

1. Tap the `Chat` tab.
2. Tap the text field labeled `Message main...`.
3. Send this exact message:

```text
Run the approval demo.
```

Expected result: the iPhone shows `Exec approval required` with the harmless
command `printf 'OpenClaw App Review approval demo complete\n'`. Tap
`Allow Once`. The chat then replies:

```text
The approval demo completed.
```

## Talk

1. Tap the `Talk` tab.
2. Tap `Start Talk`.
3. If iOS asks for microphone access, tap `Allow`.
4. If iOS asks for Speech Recognition access, tap `Allow`.
5. Confirm the screen changes to `Ready to talk` and shows `Stop Talk`.
6. Say:

```text
Summarize this review setup in one sentence.
```

Expected result: the assistant responds by voice. Tap `Stop Talk` when done.

## Talk + Background Audio

1. Tap the `Talk` tab.
2. Confirm the speaker button is highlighted.
3. Confirm the background-listening button is highlighted.
4. Tap `Start Talk`.
5. If iOS asks for microphone access, tap `Allow`.
6. If iOS asks for Speech Recognition access, tap `Allow`.
7. Confirm `Stop Talk` is visible.
8. Say:

```text
Tell me when you can hear me.
```

9. While Talk is active, send OpenClaw to the background by returning to the
   Home Screen or locking the iPhone. Do not force quit the app.
10. Continue speaking then wait for assistant audio reply.

Expected result: realtime Talk audio continues while OpenClaw is backgrounded.
Reopen OpenClaw, confirm Talk is still active, then tap `Stop Talk`.

## Gateway Status

1. Tap `Control`.
2. Tap `Instances`.
3. Confirm the screen shows `Gateway online`.
4. Confirm at least one `agent` row is connected.
5. Confirm the iPhone review device appears in the connected instances list.

## Live Activity / Dynamic Island

1. Tap `Settings`.
2. Tap `Reconnect`.
3. Immediately send OpenClaw to the background by returning to the Home Screen
   or locking the iPhone.
4. Watch the Lock Screen or Dynamic Island while the Gateway reconnects.

Expected result: while reconnecting, iOS can show an `OpenClaw` Live Activity
with connection status such as `Connecting...` or `Reconnecting...`. On a fast
network this status may be brief because OpenClaw ends the Live Activity after
the Gateway reconnects successfully.

## Push Notification

1. Tap the `Chat` tab.
2. Tap the text field labeled `Message main...`.
3. Send this exact message:

```text
Start push notification demo.
```

4. Immediately send OpenClaw to the background and lock the iPhone. Do not
   force quit the app.

Expected result: the iPhone Lock Screen receives a visible `OpenClaw`
notification with this body:

```text
OpenClaw App Review push notification demo
```

Tap the notification and unlock the iPhone if prompted. If OpenClaw opens on
`Control`, tap `Chat`. Expected chat reply:

```text
The push notification demo completed.
```

## Push Wake / Status

1. Tap the `Chat` tab.
2. Send this exact message:

```text
Start push wake demo.
```

3. Immediately send OpenClaw to the background and lock the iPhone. Do not
   force quit the app.
4. Wait for the `OpenClaw` notification on the Lock Screen. It normally appears
   about 10 seconds after the message is sent.
5. Tap the notification and unlock the iPhone if prompted. If OpenClaw opens on
   `Control`, tap `Chat`.

Expected result: the app reconnects to the live Gateway and Chat replies:

```text
The push wake and node status demo completed.
```

## Device Permissions

1. Tap `Settings`.
2. Tap `Permissions`.
3. Confirm these current app controls are available:
   - `Camera`
   - `Location` with `Off`, `While Using`, and `Always`
   - `Keep Awake`
4. Expand `Privacy & Access`.
5. Confirm these request controls are available:
   - `Contacts` / `Request Access`
   - `Calendar (Add Events)` / `Request Access`
   - `Calendar (View Events)` / `Request Full Access`
   - `Reminders` / `Request Access`

### Optional HealthKit summary

Health Summaries is off by default. Under `Privacy & Access`, tap
`Enable & Share Summaries` to see the disclosure and Apple's Health permission
sheet. OpenClaw requests read-only access to steps, sleep, resting heart rate,
and workouts. It performs aggregation on device and shares only a user-requested
`today` summary through the user's Gateway and configured AI provider;
individual samples, sources, metadata, clinical records, background
ingestion, and writes are not supported. The Gateway separately requires
`health.summary` in `gateway.nodes.allowCommands`.

The app does not infer read authorization from an empty result because HealthKit
intentionally makes denied data indistinguishable from unavailable data. This
feature is for personal health and fitness summaries only, not diagnosis or
medical advice.

## Share Sheet

1. Open Safari.
2. Navigate to `https://example.com`.
3. Tap the Safari toolbar `More` button.
4. Tap `Share`.
5. Tap `OpenClaw`.
6. Confirm the OpenClaw share extension appears and shows
   `Edit text, then tap Send.` and `Send to OpenClaw`.
7. Tap `Send to OpenClaw`.

Expected result: the OpenClaw share extension sends the shared Safari page to
the live review Gateway and shows `Sent to OpenClaw.` Returning to OpenClaw
Chat shows the shared `Example Domain` page.
