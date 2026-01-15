package com.clawdbot.android

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import com.clawdbot.android.bridge.BridgeEndpoint
import com.clawdbot.android.chat.OutgoingAttachment
import com.clawdbot.android.node.CameraCaptureManager
import com.clawdbot.android.node.CanvasController
import com.clawdbot.android.node.ScreenRecordManager
import com.clawdbot.android.node.SmsManager
import kotlinx.coroutines.flow.StateFlow

class MainViewModel(app: Application) : AndroidViewModel(app) {
  private val runtime: NodeRuntime = (app as NodeApp).runtime

  val canvas: CanvasController = runtime.canvas
  val camera: CameraCaptureManager = runtime.camera
  val screenRecorder: ScreenRecordManager = runtime.screenRecorder
  val sms: SmsManager = runtime.sms

  val bridges: StateFlow<List<BridgeEndpoint>> = runtime.bridges
  val discoveryStatusText: StateFlow<String> = runtime.discoveryStatusText

  val isConnected: StateFlow<Boolean> = runtime.isConnected
  val statusText: StateFlow<String> = runtime.statusText
  val serverName: StateFlow<String?> = runtime.serverName
  val remoteAddress: StateFlow<String?> = runtime.remoteAddress
  val isForeground: StateFlow<Boolean> = runtime.isForeground
  val seamColorArgb: StateFlow<Long> = runtime.seamColorArgb
  val mainSessionKey: StateFlow<String> = runtime.mainSessionKey

  val cameraHud: StateFlow<CameraHudState?> = runtime.cameraHud
  val cameraFlashToken: StateFlow<Long> = runtime.cameraFlashToken
  val screenRecordActive: StateFlow<Boolean> = runtime.screenRecordActive

  val instanceId: StateFlow<String> = runtime.instanceId
  val displayName: StateFlow<String> = runtime.displayName
  val cameraEnabled: StateFlow<Boolean> = runtime.cameraEnabled
  val locationMode: StateFlow<LocationMode> = runtime.locationMode
  val locationPreciseEnabled: StateFlow<Boolean> = runtime.locationPreciseEnabled
  val preventSleep: StateFlow<Boolean> = runtime.preventSleep
  val wakeWords: StateFlow<List<String>> = runtime.wakeWords
  val voiceWakeMode: StateFlow<VoiceWakeMode> = runtime.voiceWakeMode
  val voiceWakeStatusText: StateFlow<String> = runtime.voiceWakeStatusText
  val voiceWakeIsListening: StateFlow<Boolean> = runtime.voiceWakeIsListening
  val talkEnabled: StateFlow<Boolean> = runtime.talkEnabled
  val talkStatusText: StateFlow<String> = runtime.talkStatusText
  val talkIsListening: StateFlow<Boolean> = runtime.talkIsListening
  val talkIsSpeaking: StateFlow<Boolean> = runtime.talkIsSpeaking
  val manualEnabled: StateFlow<Boolean> = runtime.manualEnabled
  val manualHost: StateFlow<String> = runtime.manualHost
  val manualPort: StateFlow<Int> = runtime.manualPort
  val canvasDebugStatusEnabled: StateFlow<Boolean> = runtime.canvasDebugStatusEnabled

  val chatSessionKey: StateFlow<String> = runtime.chatSessionKey
  val chatSessionId: StateFlow<String?> = runtime.chatSessionId
  val chatMessages = runtime.chatMessages
  val chatError: StateFlow<String?> = runtime.chatError
  val chatHealthOk: StateFlow<Boolean> = runtime.chatHealthOk
  val chatThinkingLevel: StateFlow<String> = runtime.chatThinkingLevel
  val chatStreamingAssistantText: StateFlow<String?> = runtime.chatStreamingAssistantText
  val chatPendingToolCalls = runtime.chatPendingToolCalls
  val chatSessions = runtime.chatSessions
  val pendingRunCount: StateFlow<Int> = runtime.pendingRunCount

  fun setForeground(value: Boolean) {
    runtime.setForeground(value)
  }

  fun setDisplayName(value: String) {
    runtime.setDisplayName(value)
  }

  fun setCameraEnabled(value: Boolean) {
    runtime.setCameraEnabled(value)
  }

  fun setLocationMode(mode: LocationMode) {
    runtime.setLocationMode(mode)
  }

  fun setLocationPreciseEnabled(value: Boolean) {
    runtime.setLocationPreciseEnabled(value)
  }

  fun setPreventSleep(value: Boolean) {
    runtime.setPreventSleep(value)
  }

  fun setManualEnabled(value: Boolean) {
    runtime.setManualEnabled(value)
  }

  fun setManualHost(value: String) {
    runtime.setManualHost(value)
  }

  fun setManualPort(value: Int) {
    runtime.setManualPort(value)
  }

  fun setCanvasDebugStatusEnabled(value: Boolean) {
    runtime.setCanvasDebugStatusEnabled(value)
  }

  fun setWakeWords(words: List<String>) {
    runtime.setWakeWords(words)
  }

  fun resetWakeWordsDefaults() {
    runtime.resetWakeWordsDefaults()
  }

  fun setVoiceWakeMode(mode: VoiceWakeMode) {
    runtime.setVoiceWakeMode(mode)
  }

  fun setTalkEnabled(enabled: Boolean) {
    runtime.setTalkEnabled(enabled)
  }

  fun refreshBridgeHello() {
    runtime.refreshBridgeHello()
  }

  fun connect(endpoint: BridgeEndpoint) {
    runtime.connect(endpoint)
  }

  fun connectManual() {
    runtime.connectManual()
  }

  fun disconnect() {
    runtime.disconnect()
  }

  fun handleCanvasA2UIActionFromWebView(payloadJson: String) {
    runtime.handleCanvasA2UIActionFromWebView(payloadJson)
  }

  fun loadChat(sessionKey: String) {
    runtime.loadChat(sessionKey)
  }

  fun refreshChat() {
    runtime.refreshChat()
  }

  fun refreshChatSessions(limit: Int? = null) {
    runtime.refreshChatSessions(limit = limit)
  }

  fun setChatThinkingLevel(level: String) {
    runtime.setChatThinkingLevel(level)
  }

  fun switchChatSession(sessionKey: String) {
    runtime.switchChatSession(sessionKey)
  }

  fun abortChat() {
    runtime.abortChat()
  }

  fun sendChat(message: String, thinking: String, attachments: List<OutgoingAttachment>) {
    runtime.sendChat(message = message, thinking = thinking, attachments = attachments)
  }
}
