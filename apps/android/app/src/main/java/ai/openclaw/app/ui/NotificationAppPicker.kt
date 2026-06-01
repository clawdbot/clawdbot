package ai.openclaw.app.ui

import ai.openclaw.app.node.DeviceNotificationListenerService
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/** App entry shown in the notification-forwarding package picker. */
data class InstalledApp(
  val label: String,
  val packageName: String,
  val isSystemApp: Boolean,
)

/** Reads launcher, recent-notification, and configured packages for the picker. */
internal fun queryInstalledApps(
  context: Context,
  configuredPackages: Set<String>,
): List<InstalledApp> {
  val packageManager = context.packageManager
  val launcherIntent = Intent(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) }

  val launcherPackages =
    packageManager
      .queryIntentActivities(launcherIntent, PackageManager.MATCH_ALL)
      .asSequence()
      .mapNotNull {
        it.activityInfo
          ?.packageName
          ?.trim()
          ?.takeIf(String::isNotEmpty)
      }.toMutableSet()

  val recentNotificationPackages =
    DeviceNotificationListenerService
      .recentPackages(context)
      .asSequence()
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .toList()

  val candidatePackages =
    resolveNotificationCandidatePackages(
      launcherPackages = launcherPackages,
      recentPackages = recentNotificationPackages,
      configuredPackages = configuredPackages,
      appPackageName = context.packageName,
    )

  return candidatePackages
    .asSequence()
    .mapNotNull { packageName ->
      runCatching {
        val appInfo = packageManager.getApplicationInfo(packageName, 0)
        val label = packageManager.getApplicationLabel(appInfo).toString().trim()
        InstalledApp(
          label = if (label.isEmpty()) packageName else label,
          packageName = packageName,
          isSystemApp = (appInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0,
        )
      }.getOrNull()
    }.sortedWith(compareBy<InstalledApp> { it.label.lowercase() }.thenBy { it.packageName })
    .toList()
}

/** Merges package sources while excluding OpenClaw from its own forwarding filter. */
internal fun resolveNotificationCandidatePackages(
  launcherPackages: Set<String>,
  recentPackages: List<String>,
  configuredPackages: Set<String>,
  appPackageName: String,
): Set<String> {
  val blockedPackage = appPackageName.trim()
  return sequenceOf(
    configuredPackages.asSequence(),
    launcherPackages.asSequence(),
    recentPackages.asSequence(),
  ).flatten()
    .map { it.trim() }
    .filter { it.isNotEmpty() && it != blockedPackage }
    .toSet()
}
