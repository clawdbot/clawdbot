export function zoomMeetingStatusAccessSource(): string {
  return `  const passcodeInput = firstRaw(selectors.passcode);
  const passcodeRequired = Boolean(passcodeInput) &&
    /meeting passcode|enter (?:the )?passcode|invalid passcode|incorrect passcode/i.test(
      pageText + " " + label(passcodeInput)
    );
  const captchaRequired = Boolean(firstRaw(selectors.captcha)) ||
    /complete (?:the )?captcha|security check|verify (?:that )?you(?:'re| are) (?:a )?human/i.test(pageTextLower);
  if (identityVerified && !inCall && passcodeRequired) {
    controlManualActionReason = "zoom-passcode-required";
    controlManualActionMessage = "Enter the Zoom meeting passcode in the OpenClaw browser profile, then retry joining.";
  } else if (identityVerified && !inCall && captchaRequired) {
    controlManualActionReason = "zoom-captcha-required";
    controlManualActionMessage = "Complete Zoom's security check in the OpenClaw browser profile, then retry joining.";
  }
`;
}
