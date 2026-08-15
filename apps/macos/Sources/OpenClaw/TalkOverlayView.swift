import AppKit
import OpenClawChatUI
import SwiftUI

struct TalkOverlayView: View {
    var controller: TalkOverlayController
    @State private var appState = AppStateStore.shared
    @State private var hoveringWindow = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            let isPaused = self.controller.model.isPaused
            Color.clear
            TalkOrbView(
                phase: self.controller.model.phase,
                level: self.controller.model.level,
                accent: self.seamColor,
                isPaused: isPaused)
                .frame(width: TalkOverlayController.orbSize, height: TalkOverlayController.orbSize)
                .padding(.top, TalkOverlayController.orbPadding)
                .padding(.trailing, TalkOverlayController.orbPadding)
                .contentShape(Circle())
                .opacity(isPaused ? 0.55 : 1)
                .background(
                    TalkOrbInteractionView(
                        onSingleClick: { TalkModeController.shared.togglePaused() },
                        onDoubleClick: { TalkModeController.shared.stopSpeaking(reason: .userTap) },
                        onDragStart: { TalkModeController.shared.setPaused(true) }))
                .overlay(alignment: .topLeading) {
                    Button {
                        TalkModeController.shared.exitTalkMode()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(Color.white.opacity(0.95))
                            .frame(width: 18, height: 18)
                            .background(Color.black.opacity(0.4))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .contentShape(Circle())
                    .offset(x: -2, y: -2)
                    .opacity(self.hoveringWindow ? 1 : 0)
                    .animation(.easeOut(duration: 0.12), value: self.hoveringWindow)
                }
                .onHover { self.hoveringWindow = $0 }
        }
        .frame(
            width: TalkOverlayController.overlaySize,
            height: TalkOverlayController.overlaySize,
            alignment: .topTrailing)
    }

    private static let defaultSeamColor = Color(red: 79 / 255.0, green: 122 / 255.0, blue: 154 / 255.0)

    private var seamColor: Color {
        ColorHexSupport.color(fromHex: self.appState.seamColorHex) ?? Self.defaultSeamColor
    }
}

private struct TalkOrbInteractionView: NSViewRepresentable {
    let onSingleClick: () -> Void
    let onDoubleClick: () -> Void
    let onDragStart: () -> Void

    func makeNSView(context: Context) -> NSView {
        let view = OrbInteractionNSView()
        view.onSingleClick = self.onSingleClick
        view.onDoubleClick = self.onDoubleClick
        view.onDragStart = self.onDragStart
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.clear.cgColor
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        guard let view = nsView as? OrbInteractionNSView else { return }
        view.onSingleClick = self.onSingleClick
        view.onDoubleClick = self.onDoubleClick
        view.onDragStart = self.onDragStart
    }
}

private final class OrbInteractionNSView: NSView {
    var onSingleClick: (() -> Void)?
    var onDoubleClick: (() -> Void)?
    var onDragStart: (() -> Void)?
    private var mouseDownEvent: NSEvent?
    private var didDrag = false
    private var suppressSingleClick = false

    override var acceptsFirstResponder: Bool {
        true
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        self.mouseDownEvent = event
        self.didDrag = false
        self.suppressSingleClick = event.clickCount > 1
        if event.clickCount == 2 {
            self.onDoubleClick?()
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let startEvent = self.mouseDownEvent else { return }
        if !self.didDrag {
            let dx = event.locationInWindow.x - startEvent.locationInWindow.x
            let dy = event.locationInWindow.y - startEvent.locationInWindow.y
            if abs(dx) + abs(dy) < 2 { return }
            self.didDrag = true
            self.onDragStart?()
            self.window?.performDrag(with: startEvent)
        }
    }

    override func mouseUp(with event: NSEvent) {
        if !self.didDrag, !self.suppressSingleClick {
            self.onSingleClick?()
        }
        self.mouseDownEvent = nil
        self.didDrag = false
        self.suppressSingleClick = false
    }
}

private struct TalkOrbView: View {
    let phase: TalkModePhase
    let level: Double
    let accent: Color
    let isPaused: Bool

    var body: some View {
        ZStack {
            Circle()
                .fill(self.orbGradient)
                .overlay(Circle().stroke(Color.white.opacity(self.isPaused ? 0.35 : 0.45), lineWidth: 1))
                .shadow(color: Color.black.opacity(self.isPaused ? 0.18 : 0.22), radius: 10, x: 0, y: 5)
                .scaleEffect(self.orbScale)

            if !self.isPaused {
                // The universal talk waveform (shared with iOS/watchOS/Android)
                // rendered inside the orb; the level is real mic/playback audio.
                // 0.82 x 0.56 keeps the wave rect's corners inside the orb circle.
                TalkWaveformView(phase: self.wavePhase, palette: .talkOrb)
                    .frame(
                        width: TalkOverlayController.orbSize * 0.82,
                        height: TalkOverlayController.orbSize * 0.56)
                    .accessibilityHidden(true)
            }
        }
        .animation(.easeOut(duration: 0.12), value: self.orbScale)
    }

    private var wavePhase: TalkWaveformPhase {
        switch self.phase {
        case .idle: .idle
        case .thinking: .thinking
        case .listening: .listening(level: self.level, speechActive: false)
        case .speaking: .speaking(level: self.level)
        }
    }

    private var orbScale: CGFloat {
        guard !self.isPaused, self.phase == .listening || self.phase == .speaking else { return 1 }
        return 1 + CGFloat(self.level) * 0.08
    }

    private var orbGradient: RadialGradient {
        RadialGradient(
            colors: [Color.white, self.accent],
            center: .topLeading,
            startRadius: 4,
            endRadius: 52)
    }
}

extension TalkWaveformPalette {
    /// High-contrast wave tones for the tinted orb background.
    fileprivate static let talkOrb = TalkWaveformPalette(
        active: [
            Color.white,
            Color(white: 0.9),
            Color(white: 0.72),
        ],
        inactive: [
            Color.white.opacity(0.7),
            Color.white.opacity(0.55),
            Color.white.opacity(0.4),
        ])
}
