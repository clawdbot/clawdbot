const SENSITIVE_REQUEST_HEADER_NAMES = Symbol("openclaw.capture.sensitiveRequestHeaderNames");

type CaptureMetaWithSensitiveRequestHeaders = Record<string, unknown> & {
  [SENSITIVE_REQUEST_HEADER_NAMES]?: readonly string[];
};

/** Carries capture-only sensitivity metadata without serializing it into the capture record. */
export function createSensitiveRequestHeaderCaptureMeta(
  names: Iterable<string>,
): Record<string, unknown> {
  const meta: CaptureMetaWithSensitiveRequestHeaders = {};
  meta[SENSITIVE_REQUEST_HEADER_NAMES] = [...names];
  return meta;
}

export function readSensitiveRequestHeaderNamesFromCaptureMeta(
  meta: Record<string, unknown> | undefined,
): readonly string[] | undefined {
  return (meta as CaptureMetaWithSensitiveRequestHeaders | undefined)?.[
    SENSITIVE_REQUEST_HEADER_NAMES
  ];
}
