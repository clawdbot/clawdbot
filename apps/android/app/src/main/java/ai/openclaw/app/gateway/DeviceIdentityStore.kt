package ai.openclaw.app.gateway

import android.content.Context
import android.util.Base64
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.security.MessageDigest

@Serializable
data class DeviceIdentity(
  val deviceId: String,
  val publicKeyRawBase64: String,
  val privateKeyPkcs8Base64: String,
  val createdAtMs: Long,
)

class DeviceIdentityStore(
  context: Context,
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val identityFile = File(context.filesDir, "openclaw/identity/device.json")

  @Volatile private var cachedIdentity: DeviceIdentity? = null

  @Synchronized
  fun loadOrCreate(): DeviceIdentity {
    cachedIdentity?.let { return it }
    val existing = load()
    if (existing != null) {
      val derived = deriveDeviceId(existing.publicKeyRawBase64)
      if (derived != null && derived != existing.deviceId) {
        val updated = existing.copy(deviceId = derived)
        save(updated)
        cachedIdentity = updated
        return updated
      }
      cachedIdentity = existing
      return existing
    }
    val fresh = generate()
    save(fresh)
    cachedIdentity = fresh
    return fresh
  }

  fun signPayload(
    payload: String,
    identity: DeviceIdentity,
  ): String? =
    try {
      // Use BC lightweight API directly — JCA provider registration is broken by R8
      val privateKeyBytes = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)
      val pkInfo =
        org.bouncycastle.asn1.pkcs.PrivateKeyInfo
          .getInstance(privateKeyBytes)
      val parsed = pkInfo.parsePrivateKey()
      val rawPrivate =
        org.bouncycastle.asn1.DEROctetString
          .getInstance(parsed)
          .octets
      val privateKey =
        org.bouncycastle.crypto.params
          .Ed25519PrivateKeyParameters(rawPrivate, 0)
      val signer =
        org.bouncycastle.crypto.signers
          .Ed25519Signer()
      signer.init(true, privateKey)
      val payloadBytes = payload.toByteArray(Charsets.UTF_8)
      signer.update(payloadBytes, 0, payloadBytes.size)
      base64UrlEncode(signer.generateSignature())
    } catch (e: Throwable) {
      android.util.Log.e("DeviceAuth", "signPayload FAILED: ${e.javaClass.simpleName}: ${e.message}", e)
      null
    }

  fun verifySelfSignature(
    payload: String,
    signatureBase64Url: String,
    identity: DeviceIdentity,
  ): Boolean =
    try {
      val rawPublicKey = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
      val pubKey =
        org.bouncycastle.crypto.params
          .Ed25519PublicKeyParameters(rawPublicKey, 0)
      val sigBytes = base64UrlDecode(signatureBase64Url)
      val verifier =
        org.bouncycastle.crypto.signers
          .Ed25519Signer()
      verifier.init(false, pubKey)
      val payloadBytes = payload.toByteArray(Charsets.UTF_8)
      verifier.update(payloadBytes, 0, payloadBytes.size)
      verifier.verifySignature(sigBytes)
    } catch (e: Throwable) {
      android.util.Log.e("DeviceAuth", "self-verify exception: ${e.message}", e)
      false
    }

  private fun base64UrlDecode(input: String): ByteArray {
    val normalized = input.replace('-', '+').replace('_', '/')
    val padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
    return Base64.decode(padded, Base64.DEFAULT)
  }

  fun publicKeyBase64Url(identity: DeviceIdentity): String? =
    try {
      val raw = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
      base64UrlEncode(raw)
    } catch (_: Throwable) {
      null
    }

  private fun load(): DeviceIdentity? = readIdentity(identityFile)

  private fun readIdentity(file: File): DeviceIdentity? {
    return try {
      if (!file.exists()) return null
      val raw = file.readText(Charsets.UTF_8)
      val decoded = json.decodeFromString(DeviceIdentity.serializer(), raw)
      if (decoded.deviceId.isBlank() ||
        decoded.publicKeyRawBase64.isBlank() ||
        decoded.privateKeyPkcs8Base64.isBlank()
      ) {
        null
      } else {
        decoded
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun save(identity: DeviceIdentity) {
    try {
      identityFile.parentFile?.mkdirs()
      val encoded = json.encodeToString(DeviceIdentity.serializer(), identity)
      identityFile.writeText(encoded, Charsets.UTF_8)
    } catch (_: Throwable) {
      // best-effort only
    }
  }

  private fun generate(): DeviceIdentity {
    // Use BC lightweight API directly to avoid JCA provider issues with R8
    val kpGen =
      org.bouncycastle.crypto.generators
        .Ed25519KeyPairGenerator()
    kpGen.init(
      org.bouncycastle.crypto.params
        .Ed25519KeyGenerationParameters(java.security.SecureRandom()),
    )
    val kp = kpGen.generateKeyPair()
    val pubKey = kp.public as org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
    val privKey = kp.private as org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
    val rawPublic = pubKey.encoded // 32 bytes
    val deviceId = sha256Hex(rawPublic)
    // Encode private key as PKCS8 for storage
    val privKeyInfo =
      org.bouncycastle.crypto.util.PrivateKeyInfoFactory
        .createPrivateKeyInfo(privKey)
    val pkcs8Bytes = privKeyInfo.encoded
    return DeviceIdentity(
      deviceId = deviceId,
      publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
      privateKeyPkcs8Base64 = Base64.encodeToString(pkcs8Bytes, Base64.NO_WRAP),
      createdAtMs = System.currentTimeMillis(),
    )
  }

  private fun deriveDeviceId(publicKeyRawBase64: String): String? =
    try {
      val raw = Base64.decode(publicKeyRawBase64, Base64.DEFAULT)
      sha256Hex(raw)
    } catch (_: Throwable) {
      null
    }

  private fun sha256Hex(data: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(data)
    val out = CharArray(digest.size * 2)
    var i = 0
    for (byte in digest) {
      val v = byte.toInt() and 0xff
      out[i++] = HEX[v ushr 4]
      out[i++] = HEX[v and 0x0f]
    }
    return String(out)
  }

  private fun base64UrlEncode(data: ByteArray): String =
    Base64.encodeToString(
      data,
      Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )

  companion object {
    private val HEX = "0123456789abcdef".toCharArray()
  }
}
