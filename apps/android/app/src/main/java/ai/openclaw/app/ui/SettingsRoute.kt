package ai.openclaw.app.ui

import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.ui.graphics.vector.ImageVector

internal enum class SettingsCategory(
  val title: NativeText,
) {
  Connection(nativeText("Connection")),
  AgentsAutomation(nativeText("Agents & automation")),
  PhonePrivacy(nativeText("Phone context & privacy")),
  ProfileDevice(nativeText("Profile & device")),
  Diagnostics(nativeText("Diagnostics")),
}

internal enum class SettingsRoute(
  val title: NativeText,
  val icon: ImageVector,
  val category: SettingsCategory?,
) {
  Home(nativeText("Settings"), Icons.Outlined.Settings, null),
  Profile(nativeText("Profile"), Icons.Default.Person, SettingsCategory.ProfileDevice),
  Voice(nativeText("Voice"), Icons.Default.Mic, SettingsCategory.PhonePrivacy),
  Agents(nativeText("Agents"), Icons.Default.Person, SettingsCategory.AgentsAutomation),
  ProvidersModels(nativeText("Providers & Models"), Icons.Outlined.Inventory2, SettingsCategory.AgentsAutomation),
  Approvals(nativeText("Approvals"), Icons.Default.Lock, SettingsCategory.AgentsAutomation),
  CronJobs(nativeText("Automations"), Icons.Outlined.AccessTime, SettingsCategory.AgentsAutomation),
  Usage(nativeText("Usage"), Icons.Default.Storage, SettingsCategory.AgentsAutomation),
  Skills(nativeText("Skills"), Icons.Default.Settings, SettingsCategory.AgentsAutomation),
  SkillWorkshop(nativeText("Skill Workshop"), Icons.Default.Settings, SettingsCategory.AgentsAutomation),
  SystemAgent(nativeText("OpenClaw"), Icons.Default.Bolt, SettingsCategory.AgentsAutomation),
  NodesDevices(nativeText("Nodes & Devices"), Icons.Default.Cloud, SettingsCategory.Connection),
  Channels(nativeText("Channels"), Icons.Default.Notifications, SettingsCategory.Connection),
  Dreaming(nativeText("Dreaming"), Icons.Default.Storage, SettingsCategory.AgentsAutomation),
  Terminal(nativeText("Terminal"), Icons.Outlined.Terminal, SettingsCategory.AgentsAutomation),
  Desktop(nativeText("Desktop"), Icons.Outlined.DesktopWindows, SettingsCategory.AgentsAutomation),
  Notifications(nativeText("Notifications"), Icons.Default.Notifications, SettingsCategory.PhonePrivacy),
  PhoneCapabilities(nativeText("Phone Capabilities"), Icons.Default.Lock, SettingsCategory.PhonePrivacy),
  Gateway(nativeText("Gateway"), Icons.Default.Cloud, SettingsCategory.Connection),
  Appearance(nativeText("Appearance"), Icons.Default.Palette, SettingsCategory.ProfileDevice),
  Health(nativeText("Health"), Icons.Default.Settings, SettingsCategory.Diagnostics),
  About(nativeText("About"), Icons.Default.Storage, SettingsCategory.ProfileDevice),
  Licenses(nativeText("Licenses"), Icons.Default.Storage, SettingsCategory.ProfileDevice),
  ;

  fun isAvailable(desktopObserveAvailable: Boolean): Boolean = this != Desktop || desktopObserveAvailable
}
