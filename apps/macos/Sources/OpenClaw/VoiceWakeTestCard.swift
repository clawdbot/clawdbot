import SwiftUI

struct VoiceWakeTestCard: View {
    @Binding var testState: VoiceWakeTestState
    @Binding var isTesting: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Test Voice Wake")
                    .font(.callout.weight(.semibold))
                Spacer()
                Button(action: self.onToggle) {
                    Label(
                        self.isTesting ? "Stop" : "Start test",
                        systemImage: self.isTesting ? "stop.circle.fill" : "play.circle")
                }
                .buttonStyle(.borderedProminent)
                .tint(self.isTesting ? .red : .accentColor)
            }

            HStack(spacing: 8) {
                self.statusIcon
                VStack(alignment: .leading, spacing: 4) {
                    Text(self.statusText)
                        .font(.subheadline)
                        .frame(maxHeight: 22, alignment: .center)
                    if case let .detected(text) = testState {
                        Text("Heard: \(text)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer()
            }
            .padding(10)
            .background(.quaternary.opacity(0.2))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .frame(minHeight: 54)
        }
        .padding(.vertical, 2)
    }

    private var statusIcon: some View {
        switch self.testState {
        case .idle:
            AnyView(Image(systemName: "waveform").foregroundStyle(.secondary))

        case .requesting:
            AnyView(ProgressView().controlSize(.small))

        case .listening, .hearing:
            AnyView(
                Image(systemName: "ear.and.waveform")
                    .symbolEffect(.pulse)
                    .foregroundStyle(Color.accentColor))

        case .finalizing:
            AnyView(ProgressView().controlSize(.small))

        case .detected:
            AnyView(Image(systemName: "checkmark.circle.fill").foregroundStyle(.green))

        case .failed:
            AnyView(Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow))
        }
    }

    private var statusText: String {
        switch self.testState {
        case .idle:
            "Press start, say a trigger word, and wait for detection."

        case .requesting:
            "Requesting mic & speech permission…"

        case .listening:
            "Listening… say your trigger word."

        case let .hearing(text):
            "Heard: \(text)"

        case .finalizing:
            "Finalizing…"

        case .detected:
            "Voice wake detected!"

        case let .failed(reason):
            reason
        }
    }
}
