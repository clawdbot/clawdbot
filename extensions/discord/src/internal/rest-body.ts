type RequestData = {
  body?: unknown;
  multipartStyle?: "message" | "form";
  rawBody?: boolean;
  headers?: Record<string, string>;
};

export function serializeRequestBody(
  data: RequestData | undefined,
  headers: Headers,
): BodyInit | undefined {
  if (data?.headers) {
    for (const [key, value] of Object.entries(data.headers)) {
      headers.set(key, value);
    }
  }
  if (data?.body == null) {
    return undefined;
  }
  if (typeof data.body === "object") {
    const bodyObject = data.body as Record<string, unknown>;
    const topLevelFiles = Array.isArray(bodyObject.files) ? bodyObject.files : undefined;
    const nestedData =
      bodyObject.data && typeof bodyObject.data === "object"
        ? (bodyObject.data as Record<string, unknown>)
        : undefined;
    const nestedFiles =
      nestedData && Array.isArray(nestedData.files) ? nestedData.files : undefined;
    const files = topLevelFiles ?? nestedFiles;
    const filesContainer = topLevelFiles ? bodyObject : nestedFiles ? nestedData : undefined;
    if (files?.length && filesContainer) {
      if (data.multipartStyle === "form") {
        const formData = new FormData();
        for (const [key, value] of Object.entries(filesContainer)) {
          if (key === "files" || value === undefined || value === null) {
            continue;
          }
          formData.append(key, typeof value === "string" ? value : JSON.stringify(value));
        }
        for (const file of files) {
          const item = file as {
            fieldName?: unknown;
            name?: unknown;
            data?: unknown;
            contentType?: unknown;
          };
          const name = typeof item.name === "string" && item.name ? item.name : "file";
          const blob =
            item.data instanceof Blob
              ? item.data
              : new Blob([item.data as BlobPart], {
                  type: typeof item.contentType === "string" ? item.contentType : undefined,
                });
          formData.append(
            typeof item.fieldName === "string" && item.fieldName ? item.fieldName : "file",
            blob,
            name,
          );
        }
        return formData;
      }
      const payloadJson = topLevelFiles
        ? { ...bodyObject }
        : { ...bodyObject, data: { ...nestedData } };
      const payloadFilesContainer = topLevelFiles
        ? (payloadJson as Record<string, unknown>)
        : ((payloadJson as { data: Record<string, unknown> }).data ?? {});
      const formData = new FormData();
      const existingAttachments = Array.isArray(payloadFilesContainer.attachments)
        ? [...payloadFilesContainer.attachments]
        : [];
      const uploaded = files.map((file, index) => {
        const item = file as {
          name?: unknown;
          data?: unknown;
          contentType?: unknown;
          description?: unknown;
          duration_secs?: unknown;
          waveform?: unknown;
        };
        const name = typeof item.name === "string" && item.name ? item.name : `file-${index}`;
        const blob =
          item.data instanceof Blob
            ? item.data
            : new Blob([item.data as BlobPart], {
                type: typeof item.contentType === "string" ? item.contentType : undefined,
              });
        const id = existingAttachments.length + index;
        formData.append(`files[${id}]`, blob, name);
        const attachment: Record<string, unknown> = {
          id,
          filename: name,
        };
        if (typeof item.description === "string") {
          attachment.description = item.description;
        }
        if (typeof item.duration_secs === "number") {
          attachment.duration_secs = item.duration_secs;
        }
        if (typeof item.waveform === "string") {
          attachment.waveform = item.waveform;
        }
        return attachment;
      });
      payloadFilesContainer.attachments = [...existingAttachments, ...uploaded];
      delete payloadFilesContainer.files;
      formData.append("payload_json", JSON.stringify(payloadJson));
      return formData;
    }
  }
  if (!data.rawBody) {
    headers.set("Content-Type", "application/json");
  }
  return data.rawBody ? (data.body as BodyInit) : JSON.stringify(data.body);
}
