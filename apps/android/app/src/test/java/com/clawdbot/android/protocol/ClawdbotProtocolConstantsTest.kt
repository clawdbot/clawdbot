package com.clawdbot.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class MoltbotProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", MoltbotCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", MoltbotCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", MoltbotCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", MoltbotCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", MoltbotCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", MoltbotCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", MoltbotCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", MoltbotCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", MoltbotCapability.Canvas.rawValue)
    assertEquals("camera", MoltbotCapability.Camera.rawValue)
    assertEquals("screen", MoltbotCapability.Screen.rawValue)
    assertEquals("voiceWake", MoltbotCapability.VoiceWake.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", MoltbotScreenCommand.Record.rawValue)
  }
}
