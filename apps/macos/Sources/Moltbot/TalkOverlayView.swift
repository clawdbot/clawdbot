import AppKit
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
        Self.color(fromHex: self.appState.seamColorHex) ?? Self.defaultSeamColor
    }

    private static func color(fromHex raw: String?) -> Color? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hex = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
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

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

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
        if self.isPaused {
            Circle()
                .fill(self.orbGradient)
                .overlay(Circle().stroke(Color.white.opacity(0.35), lineWidth: 1))
                .shadow(color: Color.black.opacity(0.18), radius: 10, x: 0, y: 5)
        } else {
            TimelineView(.animation) { context in
                let t = context.date.timeIntervalSinceReferenceDate
                let listenScale = self.phase == .listening ? (1 + CGFloat(self.level) * 0.12) : 1
                let pulse = self.phase == .speaking ? (1 + 0.06 * sin(t * 6)) : 1

                ZStack {
                    Circle()
                        .fill(self.orbGradient)
                        .overlay(Circle().stroke(Color.white.opacity(0.45), lineWidth: 1))
                        .shadow(color: Color.black.opacity(0.22), radius: 10, x: 0, y: 5)
                        .scaleEffect(pulse * listenScale)

                    TalkWaveRings(phase: self.phase, level: self.level, time: t, accent: self.accent)

                    if self.phase == .thinking {
                        TalkOrbitArcs(time: t)
                    }
                }
            }
        }
    }

    private var orbGradient: RadialGradient {
        RadialGradient(
            colors: [Color.white, self.accent],
            center: .topLeading,
            startRadius: 4,
            endRadius: 52)
    }
}

private struct TalkWaveRings: View {
    let phase: TalkModePhase
    let level: Double
    let time: TimeInterval
    let accent: Color

    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { idx in
                let speed = self.phase == .speaking ? 1.4 : self.phase == .listening ? 0.9 : 0.6
                let progress = (time * speed + Double(idx) * 0.28).truncatingRemainder(dividingBy: 1)
                let amplitude = self.phase == .speaking ? 0.95 : self.phase == .listening ? 0.5 + self
                    .level * 0.7 : 0.35
                let scale = 0.75 + progress * amplitude + (self.phase == .listening ? self.level * 0.15 : 0)
                let alpha = self.phase == .speaking ? 0.72 : self.phase == .listening ? 0.58 + self.level * 0.28 : 0.4
                Circle()
                    .stroke(self.accent.opacity(alpha - progress * 0.3), lineWidth: 1.6)
                    .scaleEffect(scale)
                    .opacity(alpha - progress * 0.6)
            }
        }
    }
}

private struct TalkOrbitArcs: View {
    let time: TimeInterval

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0.08, to: 0.26)
                .stroke(Color.white.opacity(0.88), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                .rotationEffect(.degrees(self.time * 42))
            Circle()
                .trim(from: 0.62, to: 0.86)
                .stroke(Color.white.opacity(0.7), style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
                .rotationEffect(.degrees(-self.time * 35))
        }
        .scaleEffect(1.08)
    }
}
