package ai.openclaw.app.protocol

import org.junit.Assert.assertTrue
import org.junit.Test

class OpenClawProtocolConstantsTest {
  @Test
  fun generatedCapabilitiesAreUniqueProtocolIds() {
    val values = OpenClawCapability.entries.map { it.rawValue }

    assertTrue(values.isNotEmpty())
    assertTrue(values.all { it.isNotBlank() && "." !in it })
    assertTrue(values.size == values.toSet().size)
  }

  @Test
  fun generatedCommandGroupsMatchTheirNamespaces() {
    val groups =
      listOf(
        OpenClawCanvasCommand.NamespacePrefix to OpenClawCanvasCommand.entries.map { it.rawValue },
        OpenClawCanvasA2UICommand.NamespacePrefix to OpenClawCanvasA2UICommand.entries.map { it.rawValue },
        OpenClawCameraCommand.NamespacePrefix to OpenClawCameraCommand.entries.map { it.rawValue },
        OpenClawSmsCommand.NamespacePrefix to OpenClawSmsCommand.entries.map { it.rawValue },
        OpenClawTalkCommand.NamespacePrefix to OpenClawTalkCommand.entries.map { it.rawValue },
        OpenClawLocationCommand.NamespacePrefix to OpenClawLocationCommand.entries.map { it.rawValue },
        OpenClawDeviceCommand.NamespacePrefix to OpenClawDeviceCommand.entries.map { it.rawValue },
        OpenClawNotificationsCommand.NamespacePrefix to OpenClawNotificationsCommand.entries.map { it.rawValue },
        OpenClawSystemCommand.NamespacePrefix to OpenClawSystemCommand.entries.map { it.rawValue },
        OpenClawPhotosCommand.NamespacePrefix to OpenClawPhotosCommand.entries.map { it.rawValue },
        OpenClawContactsCommand.NamespacePrefix to OpenClawContactsCommand.entries.map { it.rawValue },
        OpenClawCalendarCommand.NamespacePrefix to OpenClawCalendarCommand.entries.map { it.rawValue },
        OpenClawMotionCommand.NamespacePrefix to OpenClawMotionCommand.entries.map { it.rawValue },
        OpenClawCallLogCommand.NamespacePrefix to OpenClawCallLogCommand.entries.map { it.rawValue },
      )

    val commands = groups.flatMap { (prefix, values) -> values.onEach { assertTrue(it.startsWith(prefix)) } }
    assertTrue(commands.size == commands.toSet().size)
  }
}
