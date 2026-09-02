/** Process-wide identity for startup recovery before its reply operation is registered. */
export const MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER = Symbol.for(
  "openclaw.mainSessionRecoveryWorkAdmission",
);
