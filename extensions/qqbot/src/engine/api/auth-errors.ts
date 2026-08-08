const QQBOT_TOKEN_EXPIRED_OR_MISSING_CODE = 11244;

/** Match QQ's HTTP and business-code signals for an invalid access token. */
export function isQQBotTokenAuthenticationFailure(httpStatus: number, bizCode?: number): boolean {
  return httpStatus === 401 || bizCode === QQBOT_TOKEN_EXPIRED_OR_MISSING_CODE;
}
