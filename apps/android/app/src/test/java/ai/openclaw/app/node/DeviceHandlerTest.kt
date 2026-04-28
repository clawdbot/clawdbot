package ai.openclaw.app.node

import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class DeviceHandlerTest {
  @Test
  fun handleDeviceInfo_returnsStablePayload() {
    val handler = DeviceHandler(appContext())

    val result = handler.handleDeviceInfo(null)

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    assertEquals("Android", payload.getValue("systemName").jsonPrimitive.content)
    assertTrue(
      payload
        .getValue("deviceName")
        .jsonPrimitive.content
        .isNotBlank(),
    )
    assertTrue(
      payload
        .getValue("modelIdentifier")
        .jsonPrimitive.content
        .isNotBlank(),
    )
    assertTrue(
      payload
        .getValue("systemVersion")
        .jsonPrimitive.content
        .isNotBlank(),
    )
    assertTrue(
      payload
        .getValue("appVersion")
        .jsonPrimitive.content
        .isNotBlank(),
    )
    assertTrue(
      payload
        .getValue("appBuild")
        .jsonPrimitive.content
        .isNotBlank(),
    )
    assertTrue(
      payload
        .getValue("locale")
        .jsonPrimitive.content
        .isNotBlank(),
    )
  }

  @Test
  fun handleDeviceStatus_returnsExpectedShape() {
    val handler = DeviceHandler(appContext())

    val result = handler.handleDeviceStatus(null)

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    val battery = payload.getValue("battery").jsonObject
    val storage = payload.getValue("storage").jsonObject
    val thermal = payload.getValue("thermal").jsonObject
    val network = payload.getValue("network").jsonObject

    val state = battery.getValue("state").jsonPrimitive.content
    assertTrue(state in setOf("unknown", "unplugged", "charging", "full"))
    battery["level"]?.jsonPrimitive?.double?.let { level ->
      assertTrue(level in 0.0..1.0)
    }
    battery.getValue("lowPowerModeEnabled").jsonPrimitive.boolean

    val totalBytes =
      storage
        .getValue("totalBytes")
        .jsonPrimitive.content
        .toLong()
    val freeBytes =
      storage
        .getValue("freeBytes")
        .jsonPrimitive.content
        .toLong()
    val usedBytes =
      storage
        .getValue("usedBytes")
        .jsonPrimitive.content
        .toLong()
    assertTrue(totalBytes >= 0L)
    assertTrue(freeBytes >= 0L)
    assertTrue(usedBytes >= 0L)
    assertEquals((totalBytes - freeBytes).coerceAtLeast(0L), usedBytes)

    val thermalState = thermal.getValue("state").jsonPrimitive.content
    assertTrue(thermalState in setOf("nominal", "fair", "serious", "critical"))

    val networkStatus = network.getValue("status").jsonPrimitive.content
    assertTrue(networkStatus in setOf("satisfied", "unsatisfied", "requiresConnection"))
    val interfaces = network.getValue("interfaces").jsonArray.map { it.jsonPrimitive.content }
    assertTrue(interfaces.all { it in setOf("wifi", "cellular", "wired", "other") })

    assertTrue(payload.getValue("uptimeSeconds").jsonPrimitive.double >= 0.0)
  }

  @Test
  fun handleDevicePermissions_returnsExpectedShape() {
    val handler = DeviceHandler(appContext())

    val result = handler.handleDevicePermissions(null)

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    val permissions = payload.getValue("permissions").jsonObject
    val expected =
      listOf(
        "camera",
        "microphone",
        "location",
        "sms",
        "notificationListener",
        "notifications",
        "photos",
        "contacts",
        "calendar",
        "callLog",
        "motion",
      )
    for (key in expected) {
      val state = permissions.getValue(key).jsonObject
      val status = state.getValue("status").jsonPrimitive.content
      assertTrue(status == "granted" || status == "denied")
      state.getValue("promptable").jsonPrimitive.boolean
      if (key == "sms") {
        val capabilities = state.getValue("capabilities").jsonObject
        for (capabilityKey in listOf("send", "read")) {
          val capability = capabilities.getValue(capabilityKey).jsonObject
          val capabilityStatus = capability.getValue("status").jsonPrimitive.content
          assertTrue(capabilityStatus == "granted" || capabilityStatus == "denied")
          capability.getValue("promptable").jsonPrimitive.boolean
        }
      }
    }
  }

  @Test
  fun smsTopLevelStatusTreatsSendOnlyPartialGrantAsGranted() {
    assertTrue(
      DeviceHandler.hasAnySmsCapability(
        smsEnabled = true,
        telephonyAvailable = true,
        smsSendGranted = true,
        smsReadGranted = false,
      ),
    )
  }

  @Test
  fun smsTopLevelStatusTreatsReadOnlyPartialGrantAsGranted() {
    assertTrue(
      DeviceHandler.hasAnySmsCapability(
        smsEnabled = true,
        telephonyAvailable = true,
        smsSendGranted = false,
        smsReadGranted = true,
      ),
    )
  }

  @Test
  fun smsTopLevelStatusTreatsNoSmsGrantAsDenied() {
    assertTrue(
      !DeviceHandler.hasAnySmsCapability(
        smsEnabled = true,
        telephonyAvailable = true,
        smsSendGranted = false,
        smsReadGranted = false,
      ),
    )
  }

  @Test
  fun smsTopLevelStatusTreatsDisabledSmsAsDenied() {
    assertTrue(
      !DeviceHandler.hasAnySmsCapability(
        smsEnabled = false,
        telephonyAvailable = true,
        smsSendGranted = true,
        smsReadGranted = true,
      ),
    )
  }

  @Test
  fun smsTopLevelStatusTreatsMissingTelephonyAsDenied() {
    assertTrue(
      !DeviceHandler.hasAnySmsCapability(
        smsEnabled = true,
        telephonyAvailable = false,
        smsSendGranted = true,
        smsReadGranted = true,
      ),
    )
  }

  @Test
  fun smsTopLevelPromptableStaysTrueUntilBothSmsPermissionsAreGranted() {
    assertTrue(
      DeviceHandler.isSmsPromptable(
        smsEnabled = true,
        telephonyAvailable = true,
        smsSendGranted = true,
        smsReadGranted = false,
      ),
    )
    assertTrue(
      !DeviceHandler.isSmsPromptable(
        smsEnabled = true,
        telephonyAvailable = true,
        smsSendGranted = true,
        smsReadGranted = true,
      ),
    )
  }

  @Test
  fun smsTopLevelPromptableIsFalseWhenSmsCannotExist() {
    assertTrue(
      !DeviceHandler.isSmsPromptable(
        smsEnabled = false,
        telephonyAvailable = true,
        smsSendGranted = false,
        smsReadGranted = false,
      ),
    )
    assertTrue(
      !DeviceHandler.isSmsPromptable(
        smsEnabled = true,
        telephonyAvailable = false,
        smsSendGranted = false,
        smsReadGranted = false,
      ),
    )
  }

  @Test
  fun handleDevicePermissions_marksCallLogUnpromptableWhenFeatureDisabled() {
    val handler = DeviceHandler(appContext(), callLogEnabled = false)

    val result = handler.handleDevicePermissions(null)

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    val callLog =
      payload
        .getValue("permissions")
        .jsonObject
        .getValue("callLog")
        .jsonObject
    assertEquals("denied", callLog.getValue("status").jsonPrimitive.content)
    assertTrue(!callLog.getValue("promptable").jsonPrimitive.boolean)
  }

  @Test
  fun handleDeviceHealth_returnsExpectedShape() {
    val handler = DeviceHandler(appContext())

    val result = handler.handleDeviceHealth(null)

    assertTrue(result.ok)
    val payload = parsePayload(result.payloadJson)
    val memory = payload.getValue("memory").jsonObject
    val battery = payload.getValue("battery").jsonObject
    val power = payload.getValue("power").jsonObject
    val system = payload.getValue("system").jsonObject

    val pressure = memory.getValue("pressure").jsonPrimitive.content
    assertTrue(pressure in setOf("normal", "moderate", "high", "critical", "unknown"))
    val totalRamBytes =
      memory
        .getValue("totalRamBytes")
        .jsonPrimitive.content
        .toLong()
    val availableRamBytes =
      memory
        .getValue("availableRamBytes")
        .jsonPrimitive.content
        .toLong()
    val usedRamBytes =
      memory
        .getValue("usedRamBytes")
        .jsonPrimitive.content
        .toLong()
    assertTrue(totalRamBytes >= 0L)
    assertTrue(availableRamBytes >= 0L)
    assertTrue(usedRamBytes >= 0L)
    memory.getValue("lowMemory").jsonPrimitive.boolean

    val batteryState = battery.getValue("state").jsonPrimitive.content
    assertTrue(batteryState in setOf("unknown", "unplugged", "charging", "full"))
    val chargingType = battery.getValue("chargingType").jsonPrimitive.content
    assertTrue(chargingType in setOf("none", "ac", "usb", "wireless", "dock"))
    battery["temperatureC"]?.jsonPrimitive?.double
    battery["currentMa"]?.jsonPrimitive?.double

    power.getValue("dozeModeEnabled").jsonPrimitive.boolean
    power.getValue("lowPowerModeEnabled").jsonPrimitive.boolean
    system["securityPatchLevel"]?.jsonPrimitive?.content
  }

  private fun appContext(): Context = RuntimeEnvironment.getApplication()

  private fun parsePayload(payloadJson: String?): JsonObject {
    val jsonString = payloadJson ?: error("expected payload")
    return Json.parseToJsonElement(jsonString).jsonObject
  }
}
