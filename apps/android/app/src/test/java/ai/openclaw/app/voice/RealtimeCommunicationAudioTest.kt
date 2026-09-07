package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioManager
import android.os.Looper
import kotlinx.coroutines.CancellationException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RealtimeCommunicationAudioTest {
  private val manager = RuntimeEnvironment.getApplication().getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val sessions = mutableListOf<RealtimeCommunicationAudio>()

  private fun open() = RealtimeCommunicationAudio.open(manager).also { sessions += it }

  @After
  fun cleanup() {
    sessions.forEach { it.close() }
    shadowOf(manager).lockMode(false)
    manager.mode = AudioManager.MODE_NORMAL
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test
  fun communicationEligibilityFollowsFocusAndModeCallbacks() {
    val session = open()
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(session.eligible)
    val listener = shadowOf(manager).lastAudioFocusRequest.listener
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
    assertFalse(session.eligible)
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
    assertTrue(session.eligible)
    manager.mode = AudioManager.MODE_IN_CALL
    shadowOf(Looper.getMainLooper()).idle()
    assertFalse(session.eligible)
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(session.eligible)
  }

  @Test
  fun refusedFocusDoesNotChangeTheDeviceMode() {
    manager.mode = AudioManager.MODE_IN_CALL
    shadowOf(manager).setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
    assertThrows(IllegalStateException::class.java) { open() }
    assertEquals(AudioManager.MODE_IN_CALL, manager.mode)
    assertEquals(shadowOf(manager).lastAudioFocusRequest.audioFocusRequest, shadowOf(manager).lastAbandonedAudioFocusRequest)
  }

  @Test
  fun modeRefusalDoesNotGrantDuplex() {
    shadowOf(manager).lockMode(true)
    assertFalse(open().eligible)
  }

  @Test
  fun staleCloseAndFocusCallbacksCannotRevokeAReplacement() {
    val old = open()
    val oldListener = shadowOf(manager).lastAudioFocusRequest.listener
    val replacement = open()
    old.close()
    oldListener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
    shadowOf(Looper.getMainLooper()).idle()
    assertFalse(old.eligible)
    assertTrue(replacement.eligible)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
  }

  @Test
  fun closeWithdrawsOwnRequestInsteadOfReassertingThePreviousGlobalMode() {
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    val session = open()
    val request = shadowOf(manager).lastAudioFocusRequest
    session.close()
    request.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
    assertFalse(session.eligible)
    assertEquals(AudioManager.MODE_NORMAL, manager.mode)
    assertEquals(request.audioFocusRequest, shadowOf(manager).lastAbandonedAudioFocusRequest)
  }

  @Test
  fun cancelledOpenerCannotAcquireOverTheReplacement() {
    val replacement = open()
    val request = shadowOf(manager).lastAudioFocusRequest
    assertThrows(CancellationException::class.java) {
      RealtimeCommunicationAudio.open(manager, isCurrent = { false })
    }
    assertTrue(replacement.eligible)
    assertEquals(request, shadowOf(manager).lastAudioFocusRequest)
    assertEquals(AudioManager.MODE_IN_COMMUNICATION, manager.mode)
  }

  @Test
  fun focusLossReportsToTheCurrentCaptureOwnerOnly() {
    var current = true
    var losses = 0
    val session = RealtimeCommunicationAudio.open(manager, { current }, { losses++ }).also { sessions += it }
    val listener = shadowOf(manager).lastAudioFocusRequest.listener
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
    assertFalse(session.eligible)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, losses)
    listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
    current = false
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, losses)
  }
}
