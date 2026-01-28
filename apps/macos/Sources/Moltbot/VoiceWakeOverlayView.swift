import SwiftUI

struct VoiceWakeOverlayView: View {
    var controller: VoiceWakeOverlayController
    @FocusState private var textFocused: Bool
    @State private var isHovering: Bool = false
    @State private var closeHovering: Bool = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            HStack(alignment: .top, spacing: 8) {
                if self.controller.model.isEditing {
                    TranscriptTextView(
                        text: Binding(
                            get: { self.controller.model.text },
                            set: { self.controller.updateText($0) }),
                        attributed: self.controller.model.attributed,
                        isFinal: self.controller.model.isFinal,
                        isOverflowing: self.controller.model.isOverflowing,
                        onBeginEditing: {
                            self.controller.userBeganEditing()
                        },
                        onEscape: {
                            self.controller.cancelEditingAndDismiss()
                        },
                        onEndEditing: {
                            self.controller.endEditing()
                        },
                        onSend: {
                            self.controller.requestSend()
                        })
                        .focused(self.$textFocused)
                        .frame(maxWidth: .infinity, minHeight: 32, maxHeight: .infinity, alignment: .topLeading)
                        .id("editing")
                } else {
                    VibrantLabelView(
                        attributed: self.controller.model.attributed,
                        onTap: {
                            self.controller.userBeganEditing()
                            self.textFocused = true
                        })
                        .frame(maxWidth: .infinity, minHeight: 32, maxHeight: .infinity, alignment: .topLeading)
                        .focusable(false)
                        .id("display")
                }

                Button {
                    self.controller.requestSend()
                } label: {
                    let sending = self.controller.model.isSending
                    let level = self.controller.model.level
                    ZStack {
                        GeometryReader { geo in
                            let width = geo.size.width
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.accentColor.opacity(0.12))
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.accentColor.opacity(0.25))
                                .frame(width: width * max(0, min(1, level)), alignment: .leading)
                                .animation(.easeOut(duration: 0.08), value: level)
                        }
                        .frame(height: 28)

                        ZStack {
                            Image(systemName: "paperplane.fill")
                                .opacity(sending ? 0 : 1)
                                .scaleEffect(sending ? 0.5 : 1)
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                                .opacity(sending ? 1 : 0)
                                .scaleEffect(sending ? 1.05 : 0.8)
                        }
                        .imageScale(.small)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .frame(width: 32, height: 28)
                    .animation(.spring(response: 0.35, dampingFraction: 0.78), value: sending)
                }
                .buttonStyle(.plain)
                .disabled(!self.controller.model.forwardEnabled || self.controller.model.isSending)
                .keyboardShortcut(.return, modifiers: [.command])
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background {
                OverlayBackground()
                    .equatable()
            }
            .shadow(color: Color.black.opacity(0.22), radius: 14, x: 0, y: -2)
            .onHover { self.isHovering = $0 }

            // Close button rendered above and outside the clipped bubble
            CloseButtonOverlay(
                isVisible: self.controller.model.isEditing || self.isHovering || self.closeHovering,
                onHover: { self.closeHovering = $0 },
                onClose: { self.controller.cancelEditingAndDismiss() })
        }
        .padding(.top, self.controller.closeOverflow)
        .padding(.leading, self.controller.closeOverflow)
        .padding(.trailing, self.controller.closeOverflow)
        .padding(.bottom, self.controller.closeOverflow)
        .onAppear {
            self.updateFocusState(visible: self.controller.model.isVisible, editing: self.controller.model.isEditing)
        }
        .onChange(of: self.controller.model.isVisible) { _, visible in
            self.updateFocusState(visible: visible, editing: self.controller.model.isEditing)
        }
        .onChange(of: self.controller.model.isEditing) { _, editing in
            self.updateFocusState(visible: self.controller.model.isVisible, editing: editing)
        }
        .onChange(of: self.controller.model.attributed) { _, _ in
            self.controller.updateWindowFrame(animate: true)
        }
    }

    private func updateFocusState(visible: Bool, editing: Bool) {
        let shouldFocus = visible && editing
        guard self.textFocused != shouldFocus else { return }
        self.textFocused = shouldFocus
    }
}

private struct OverlayBackground: View {
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        VisualEffectView(material: .hudWindow, blendingMode: .behindWindow)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Color.white.opacity(0.16), lineWidth: 1))
    }
}

extension OverlayBackground: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool { true }
}

struct CloseHoverButton: View {
    var onClose: () -> Void

    var body: some View {
        Button(action: self.onClose) {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Color.white.opacity(0.85))
                .frame(width: 22, height: 22)
                .background(Color.black.opacity(0.35))
                .clipShape(Circle())
                .shadow(color: Color.black.opacity(0.35), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .focusable(false)
        .contentShape(Circle())
        .padding(6)
    }
}

struct CloseButtonOverlay: View {
    var isVisible: Bool
    var onHover: (Bool) -> Void
    var onClose: () -> Void

    var body: some View {
        Group {
            if self.isVisible {
                Button(action: self.onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Color.white.opacity(0.9))
                        .frame(width: 22, height: 22)
                        .background(Color.black.opacity(0.4))
                        .clipShape(Circle())
                        .shadow(color: Color.black.opacity(0.45), radius: 10, x: 0, y: 3)
                        .shadow(color: Color.black.opacity(0.2), radius: 2, x: 0, y: 0)
                }
                .buttonStyle(.plain)
                .focusable(false)
                .contentShape(Circle())
                .padding(6)
                .onHover { self.onHover($0) }
                .offset(x: -9, y: -9)
                .transition(.opacity)
            }
        }
        .allowsHitTesting(self.isVisible)
    }
}
