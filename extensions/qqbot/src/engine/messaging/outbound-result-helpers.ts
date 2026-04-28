import path from "node:path";
import { UPLOAD_PREPARE_FALLBACK_CODE } from "../api/retry.js";
import { MediaFileType } from "../types.js";
import { formatFileSize, getFileTypeName, getMaxUploadSize } from "../utils/file-utils.js";
import {
  DEFAULT_MEDIA_SEND_ERROR,
  OUTBOUND_ERROR_CODES,
  type OutboundResult,
} from "./outbound-types.js";
import { UploadDailyLimitExceededError } from "./sender.js";

/**
 * Convert a media send result into a user-facing message.
 */
export function resolveUserFacingMediaError(
  result: Pick<OutboundResult, "error" | "errorCode" | "qqBizCode">,
): string {
  if (!result.error) {
    return DEFAULT_MEDIA_SEND_ERROR;
  }
  if (result.qqBizCode === UPLOAD_PREPARE_FALLBACK_CODE) {
    return result.error;
  }
  switch (result.errorCode) {
    case OUTBOUND_ERROR_CODES.FILE_TOO_LARGE:
    case OUTBOUND_ERROR_CODES.UPLOAD_DAILY_LIMIT_EXCEEDED:
      return result.error;
    default:
      return DEFAULT_MEDIA_SEND_ERROR;
  }
}

export function buildDailyLimitExceededResult(err: UploadDailyLimitExceededError): OutboundResult {
  const dir = path.dirname(err.filePath);
  const name = path.basename(err.filePath);
  const size = formatFileSize(err.fileSize);
  return {
    channel: "qqbot",
    error: `QQBot每天发送文件有累计2G的限制，如果着急的话，可以直接来我的主机copy下载，文件目录\`${dir}/${name}\`（${size}）`,
    errorCode: OUTBOUND_ERROR_CODES.UPLOAD_DAILY_LIMIT_EXCEEDED,
    qqBizCode: UPLOAD_PREPARE_FALLBACK_CODE,
  };
}

export function buildFileTooLargeResult(fileType: MediaFileType, fileSize: number): OutboundResult {
  const typeName = getFileTypeName(fileType);
  const limit = getMaxUploadSize(fileType);
  const limitMB = Math.round(limit / (1024 * 1024));
  return {
    channel: "qqbot",
    error: `${typeName}过大（${formatFileSize(fileSize)}），超过了${limitMB}M，暂时不能通过QQ直接发给你。`,
    errorCode: OUTBOUND_ERROR_CODES.FILE_TOO_LARGE,
  };
}
