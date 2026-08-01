import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { toErrorObject } from "../infra/errors.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import { resolvePinnedHostname } from "../infra/net/ssrf.js";
import { formatMediaLimitMb, MEDIA_FILE_MODE } from "./store.shared.js";

const RESPONSE_HEADER_TIMEOUT_MS = 30_000;
const READ_IDLE_TIMEOUT_MS = 30_000;

type RequestImpl = typeof httpRequest;
type ResolvePinnedHostnameImpl = typeof resolvePinnedHostname;

const defaultHttpRequestImpl: RequestImpl = httpRequest;
const defaultHttpsRequestImpl: RequestImpl = httpsRequest;
const defaultResolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = resolvePinnedHostname;

let httpRequestImpl: RequestImpl = defaultHttpRequestImpl;
let httpsRequestImpl: RequestImpl = defaultHttpsRequestImpl;
let resolvePinnedHostnameImpl: ResolvePinnedHostnameImpl = defaultResolvePinnedHostnameImpl;
let responseHeaderTimeoutMsImpl = RESPONSE_HEADER_TIMEOUT_MS;
let readIdleTimeoutMsImpl = READ_IDLE_TIMEOUT_MS;

/** Overrides remote-download dependencies for media-store tests. */
export function setMediaStoreDownloadDepsForTest(deps?: {
  httpRequest?: RequestImpl;
  httpsRequest?: RequestImpl;
  resolvePinnedHostname?: ResolvePinnedHostnameImpl;
  responseHeaderTimeoutMs?: number;
  readIdleTimeoutMs?: number;
}): void {
  httpRequestImpl = deps?.httpRequest ?? defaultHttpRequestImpl;
  httpsRequestImpl = deps?.httpsRequest ?? defaultHttpsRequestImpl;
  resolvePinnedHostnameImpl = deps?.resolvePinnedHostname ?? defaultResolvePinnedHostnameImpl;
  responseHeaderTimeoutMsImpl = deps?.responseHeaderTimeoutMs ?? RESPONSE_HEADER_TIMEOUT_MS;
  readIdleTimeoutMsImpl = deps?.readIdleTimeoutMs ?? READ_IDLE_TIMEOUT_MS;
}

type MediaDownloadResult = {
  headerMime?: string;
  sniffBuffer: Buffer;
  size: number;
};

type DownloadMediaToFileParams = {
  url: string;
  dest: string;
  headers?: Record<string, string>;
  maxRedirects?: number;
  maxBytes: number;
};

function closeIgnoredHttpResponse(res: IncomingMessage): void {
  // Unconsumed redirect/error bodies can otherwise retain their socket forever.
  res.resume();
  res.destroy();
}

/** Streams a bounded HTTP(S) response into a caller-owned sibling temp path. */
export async function downloadMediaToFile(
  params: DownloadMediaToFileParams,
): Promise<MediaDownloadResult> {
  const { url, dest, headers, maxBytes } = params;
  const maxRedirects = params.maxRedirects ?? 5;
  return await new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error("Invalid URL"));
      return;
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      reject(new Error(`Invalid URL protocol: ${parsedUrl.protocol}. Only HTTP/HTTPS allowed.`));
      return;
    }
    const requestImpl = parsedUrl.protocol === "https:" ? httpsRequestImpl : httpRequestImpl;
    const responseHeaderTimeoutMs = responseHeaderTimeoutMsImpl;
    const readIdleTimeoutMs = readIdleTimeoutMsImpl;
    let settled = false;
    let headerTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let activeRequest: ClientRequest | undefined;
    let activeResponse: IncomingMessage | undefined;
    let outStream: ReturnType<typeof createWriteStream> | undefined;
    let bodyPipeline: Promise<void> | undefined;

    const clearDownloadTimers = () => {
      if (headerTimer !== undefined) {
        clearTimeout(headerTimer);
        headerTimer = undefined;
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    // Abort first, await stream close, then unlink. Windows cannot remove an
    // open partial file, and no failed download may survive this boundary.
    const cleanupFailedDownload = async (err?: Error) => {
      clearDownloadTimers();
      activeRequest?.destroy(err);
      activeResponse?.destroy();
      outStream?.destroy(err);
      if (bodyPipeline) {
        await bodyPipeline.catch(() => {});
      }
      await fs.rm(dest, { force: true }).catch(() => {});
    };

    const settleReject = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      const failure = toErrorObject(err, "Non-Error rejection");
      void cleanupFailedDownload(failure).finally(() => reject(failure));
    };

    const settleResolve = (value: MediaDownloadResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearDownloadTimers();
      resolve(value);
    };

    const resetIdleTimer = () => {
      if (settled) {
        return;
      }
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        settleReject(
          new Error(`Media download stalled: no data received for ${readIdleTimeoutMs}ms`),
        );
      }, readIdleTimeoutMs);
      idleTimer.unref?.();
    };

    // DNS/NSS resolution is part of the wait for response headers. Start this
    // before resolution so no pre-request phase can pin the caller forever.
    headerTimer = setTimeout(() => {
      settleReject(
        new Error(
          `Media download timed out waiting for response headers after ${responseHeaderTimeoutMs}ms`,
        ),
      );
    }, responseHeaderTimeoutMs);
    headerTimer.unref?.();

    const onResponse = (res: IncomingMessage) => {
      if (settled) {
        res.destroy();
        return;
      }
      if (headerTimer !== undefined) {
        clearTimeout(headerTimer);
        headerTimer = undefined;
      }
      activeResponse = res;
      // Response errors can arrive before pipeline() owns the readable.
      res.on("error", settleReject);
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location;
        if (!location || maxRedirects <= 0) {
          closeIgnoredHttpResponse(res);
          settleReject(new Error("Redirect loop or missing Location header"));
          return;
        }
        let redirectUrl: URL;
        try {
          redirectUrl = new URL(location, url);
        } catch {
          closeIgnoredHttpResponse(res);
          settleReject(new Error("Invalid redirect Location header"));
          return;
        }
        const redirectHeaders =
          redirectUrl.origin === parsedUrl.origin
            ? headers
            : retainSafeHeadersForCrossOriginRedirect(headers);
        settled = true;
        clearDownloadTimers();
        // Redirect bodies are irrelevant and may never finish. Close this hop
        // before recursing so every DNS-to-headers phase has its own deadline.
        closeIgnoredHttpResponse(res);
        activeRequest?.destroy();
        resolve(
          downloadMediaToFile({
            url: redirectUrl.href,
            dest,
            headers: redirectHeaders,
            maxRedirects: maxRedirects - 1,
            maxBytes,
          }),
        );
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        closeIgnoredHttpResponse(res);
        settleReject(new Error(`HTTP ${res.statusCode ?? "?"} downloading media`));
        return;
      }
      let total = 0;
      const sniffChunks: Buffer[] = [];
      let sniffLen = 0;
      outStream = createWriteStream(dest, { mode: MEDIA_FILE_MODE });
      resetIdleTimer();
      res.on("data", (chunk: Buffer) => {
        resetIdleTimer();
        total += chunk.length;
        if (sniffLen < 16_384) {
          const remaining = 16_384 - sniffLen;
          sniffChunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
          sniffLen += Math.min(chunk.length, remaining);
        }
        if (total > maxBytes) {
          settleReject(new Error(`Media exceeds ${formatMediaLimitMb(maxBytes)} limit`));
        }
      });
      bodyPipeline = pipeline(res, outStream)
        .then(() => {
          const rawHeader = res.headers["content-type"];
          settleResolve({
            headerMime: Array.isArray(rawHeader) ? rawHeader[0] : rawHeader,
            sniffBuffer: Buffer.concat(sniffChunks, sniffLen),
            size: total,
          });
        })
        .catch(settleReject);
    };

    void (async () => {
      const pinned = await resolvePinnedHostnameImpl(parsedUrl.hostname);
      // A timed-out resolver may still finish; never let it open a late socket.
      if (settled) {
        return;
      }
      const req = requestImpl(parsedUrl, { headers, lookup: pinned.lookup }, onResponse);
      activeRequest = req;
      req.on("error", settleReject);
      // Test seams may invoke onResponse synchronously during construction.
      if (settled) {
        req.destroy();
        return;
      }
      req.end();
    })().catch(settleReject);
  });
}
