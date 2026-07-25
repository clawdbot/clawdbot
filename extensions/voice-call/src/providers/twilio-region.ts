// Keep config validation and REST routing on the same closed set of supported Regions.
export const TWILIO_REGIONS = ["us1", "ie1", "au1"] as const;
export type TwilioRegion = (typeof TWILIO_REGIONS)[number];

const TWILIO_API_HOSTNAME_BY_REGION = {
  us1: "api.twilio.com",
  ie1: "api.dublin.ie1.twilio.com",
  au1: "api.sydney.au1.twilio.com",
} satisfies Record<TwilioRegion, string>;

const TWILIO_API_HOSTNAMES = new Set(Object.values(TWILIO_API_HOSTNAME_BY_REGION));

function resolveTwilioApiHostname(region?: TwilioRegion): string {
  return TWILIO_API_HOSTNAME_BY_REGION[region ?? "us1"];
}

export function resolveTwilioApiBaseUrl(params: {
  accountSid: string;
  region?: TwilioRegion;
}): string {
  const hostname = resolveTwilioApiHostname(params.region);
  return `https://${hostname}/2010-04-01/Accounts/${params.accountSid}`;
}

export function requireSupportedTwilioApiHostname(baseUrl: string): string {
  const hostname = new URL(baseUrl).hostname;
  if (!TWILIO_API_HOSTNAMES.has(hostname)) {
    throw new Error(`Unsupported Twilio API hostname: ${hostname}`);
  }
  return hostname;
}
