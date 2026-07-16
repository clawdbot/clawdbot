export async function twilioApiRequest<T = unknown>(params: {
  baseUrl: string;
  accountSid: string;
  authToken: string;
  endpoint: string;
  body: URLSearchParams | Record<string, string | string[]>;
  allowNotFound?: boolean;
}): Promise<T> {
  const bodyParams =
    params.body instanceof URLSearchParams
      ? params.body
      : Object.entries(params.body).reduce((acc, [key, value]) => {
          if (Array.isArray(value)) {
            for (const entry of value) {
              acc.append(key, entry);
            }
          } else if (typeof value === "string") {
            acc.append(key, value);
          }
          return acc;
        }, new URLSearchParams());

  const response = await fetch(`${params.baseUrl}${params.endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: bodyParams,
  });

  if (!response.ok) {
    if (params.allowNotFound && response.status === 404) {
      return undefined as T;
    }
    const errorText = await response.text();
    throw new Error(`Twilio API error: ${response.status} ${errorText}`);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
