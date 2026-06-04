import { escapeXml } from "../voice-mapping.js";

// TwiML builders for manager-initiated notify and DTMF redirect flows.

/** Generate TwiML that speaks one notification and hangs up. */
export function generateNotifyTwiml(message: string, voice: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
}

/** Generate TwiML that plays DTMF digits before redirecting to a webhook URL. */
export function generateDtmfRedirectTwiml(digits: string, webhookUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${escapeXml(digits)}" />
  <Redirect method="POST">${escapeXml(webhookUrl)}</Redirect>
</Response>`;
}
