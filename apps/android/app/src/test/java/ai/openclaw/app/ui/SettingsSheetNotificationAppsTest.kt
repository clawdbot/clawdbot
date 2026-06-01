package ai.openclaw.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsSheetNotificationAppsTest {
  @Test
  fun resolveNotificationCandidatePackages_keepsConfiguredPackagesVisible() {
    val packages =
      resolveNotificationCandidatePackages(
        launcherPackages = setOf("com.example.launcher"),
        recentPackages = listOf("com.example.recent", "com.example.launcher"),
        configuredPackages = setOf("com.example.configured"),
        appPackageName = "ai.openclaw.app",
      )

    assertEquals(
      setOf("com.example.launcher", "com.example.recent", "com.example.configured"),
      packages,
    )
  }

  @Test
  fun resolveNotificationCandidatePackages_filtersBlankAndSelfPackages() {
    val packages =
      resolveNotificationCandidatePackages(
        launcherPackages = setOf(" ", "ai.openclaw.app"),
        recentPackages = listOf("com.example.recent", "  "),
        configuredPackages = setOf("ai.openclaw.app", "com.example.configured"),
        appPackageName = "ai.openclaw.app",
      )

    assertEquals(setOf("com.example.recent", "com.example.configured"), packages)
  }

  @Test
  fun filterNotificationAppsForPicker_keepsSelectedSystemPackagesVisible() {
    val apps =
      listOf(
        InstalledApp(label = "Android System", packageName = "android", isSystemApp = true),
        InstalledApp(label = "Phone Services", packageName = "com.android.phone", isSystemApp = true),
        InstalledApp(label = "Gmail", packageName = "com.google.android.gm", isSystemApp = false),
      )

    val filtered =
      filterNotificationAppsForPicker(
        apps = apps,
        selectedPackages = setOf("com.android.phone"),
        query = "",
        showSystemApps = false,
      )

    assertEquals(
      listOf("com.android.phone", "com.google.android.gm"),
      filtered.map { it.packageName },
    )
  }

  @Test
  fun filterNotificationAppsForPicker_matchesLabelsAndPackageNames() {
    val apps =
      listOf(
        InstalledApp(label = "Gmail", packageName = "com.google.android.gm", isSystemApp = false),
        InstalledApp(label = "Calendar", packageName = "com.google.android.calendar", isSystemApp = false),
      )

    val filtered =
      filterNotificationAppsForPicker(
        apps = apps,
        selectedPackages = emptySet(),
        query = "gm",
        showSystemApps = false,
      )

    assertEquals(listOf("com.google.android.gm"), filtered.map { it.packageName })
  }
}
