package ai.openclaw.app.gateway

import android.os.Build
import java.net.InetAddress
import java.util.Locale

internal fun isLoopbackGatewayHost(
  rawHost: String?,
  allowEmulatorBridgeAlias: Boolean = isAndroidEmulatorRuntime(),
): Boolean {
  var host =
    rawHost
      ?.trim()
      ?.lowercase(Locale.US)
      ?.trim('[', ']')
      .orEmpty()
  if (host.endsWith(".")) {
    host = host.dropLast(1)
  }
  val zoneIndex = host.indexOf('%')
  if (zoneIndex >= 0) return false
  if (host.isEmpty()) return false
  if (host == "localhost") return true
  if (allowEmulatorBridgeAlias && host == "10.0.2.2") return true

  parseIpv4Address(host)?.let { ipv4 ->
    return ipv4.first() == 127.toByte()
  }
  if (!host.contains(':') || !host.all(::isIpv6LiteralChar)) return false

  val address = runCatching { InetAddress.getByName(host) }.getOrNull()?.address ?: return false
  if (address.size == 4) {
    return address[0] == 127.toByte()
  }
  if (address.size != 16) return false
  // `::1` is 15 zero bytes followed by `0x01`.
  val isIpv6Loopback = address.copyOfRange(0, 15).all { it == 0.toByte() } && address[15] == 1.toByte()
  if (isIpv6Loopback) return true

  val isMappedIpv4 =
    address.copyOfRange(0, 10).all { it == 0.toByte() } &&
      address[10] == 0xFF.toByte() &&
      address[11] == 0xFF.toByte()
  return isMappedIpv4 && address[12] == 127.toByte()
}

internal fun isPrivateLanGatewayHost(
  rawHost: String?,
  allowEmulatorBridgeAlias: Boolean = isAndroidEmulatorRuntime(),
): Boolean {
  var host =
    rawHost
      ?.trim()
      ?.lowercase(Locale.US)
      ?.trim('[', ']')
      .orEmpty()
  if (host.endsWith(".")) {
    host = host.dropLast(1)
  }
  val zoneIndex = host.indexOf('%')
  if (zoneIndex >= 0) {
    host = host.substring(0, zoneIndex)
  }
  if (host.isEmpty()) return false
  if (isLoopbackGatewayHost(host, allowEmulatorBridgeAlias = allowEmulatorBridgeAlias)) return true

  parseIpv4Address(host)?.let { ipv4 ->
    val first = ipv4[0].toInt() and 0xff
    val second = ipv4[1].toInt() and 0xff
    return when {
      first == 10 -> true
      first == 172 && second in 16..31 -> true
      first == 192 && second == 168 -> true
      first == 169 && second == 254 -> true
      else -> false
    }
  }
  if (!host.contains(':') || !host.all(::isIpv6LiteralChar)) return false

  val address = runCatching { InetAddress.getByName(host) }.getOrNull() ?: return false
  return when {
    address.isLinkLocalAddress -> true
    address.isSiteLocalAddress -> true
    else -> {
      val bytes = address.address
      bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc
    }
  }
}

private fun isAndroidEmulatorRuntime(): Boolean {
  val fingerprint = Build.FINGERPRINT?.lowercase(Locale.US).orEmpty()
  val model = Build.MODEL?.lowercase(Locale.US).orEmpty()
  val manufacturer = Build.MANUFACTURER?.lowercase(Locale.US).orEmpty()
  val brand = Build.BRAND?.lowercase(Locale.US).orEmpty()
  val device = Build.DEVICE?.lowercase(Locale.US).orEmpty()
  val product = Build.PRODUCT?.lowercase(Locale.US).orEmpty()

  return fingerprint.contains("generic") ||
    fingerprint.contains("robolectric") ||
    model.contains("emulator") ||
    model.contains("sdk_gphone") ||
    manufacturer.contains("genymotion") ||
    (brand.contains("generic") && device.contains("generic")) ||
    product.contains("sdk_gphone") ||
    product.contains("emulator") ||
    product.contains("simulator")
}

private fun parseIpv4Address(host: String): ByteArray? {
  val parts = host.split('.')
  if (parts.size != 4) return null
  val bytes = ByteArray(4)
  for ((index, part) in parts.withIndex()) {
    val value = part.toIntOrNull() ?: return null
    if (value !in 0..255) return null
    bytes[index] = value.toByte()
  }
  return bytes
}

private fun isIpv6LiteralChar(char: Char): Boolean = char in '0'..'9' || char in 'a'..'f' || char == ':' || char == '.'
