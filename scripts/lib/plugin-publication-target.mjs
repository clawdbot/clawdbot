/** The source manifest owns publication eligibility, including bundled-only deferral. */
export function isPluginPublicationEnabled(packageJson, target) {
  return (
    packageJson.openclaw?.build?.bundledDist !== true &&
    (target === "npm"
      ? packageJson.openclaw?.release?.publishToNpm === true
      : packageJson.openclaw?.release?.publishToClawHub === true)
  );
}
