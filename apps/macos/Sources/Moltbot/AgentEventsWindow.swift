import MoltbotProtocol
import SwiftUI

@MainActor
struct AgentEventsWindow: View {
    private let store = AgentEventStore.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Agent Events")
                    .font(.title3.weight(.semibold))
                Spacer()
                Button("Clear") { self.store.clear() }
                    .buttonStyle(.bordered)
            }
            .padding(.bottom, 4)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(self.store.events.reversed(), id: \.seq) { evt in
                        EventRow(event: evt)
                    }
                }
            }
        }
        .padding(12)
        .frame(minWidth: 520, minHeight: 360)
    }
}

private struct EventRow: View {
    let event: ControlAgentEvent

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(self.event.stream.uppercased())
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(self.tint)
                    .foregroundStyle(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                Text("run " + self.event.runId)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Text(self.formattedTs)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if let json = self.prettyJSON(event.data) {
                Text(json)
                    .font(.caption.monospaced())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
            }
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.primary.opacity(0.04)))
    }

    private var tint: Color {
        switch self.event.stream {
        case "lifecycle": .blue
        case "tool": .orange
        case "assistant": .green
        default: .gray
        }
    }

    private var formattedTs: String {
        let date = Date(timeIntervalSince1970: event.ts / 1000)
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f.string(from: date)
    }

    private func prettyJSON(_ dict: [String: MoltbotProtocol.AnyCodable]) -> String? {
        let normalized = dict.mapValues { $0.value }
        guard JSONSerialization.isValidJSONObject(normalized),
              let data = try? JSONSerialization.data(withJSONObject: normalized, options: [.prettyPrinted]),
              let str = String(data: data, encoding: .utf8)
        else { return nil }
        return str
    }
}

struct AgentEventsWindow_Previews: PreviewProvider {
    static var previews: some View {
        let sample = ControlAgentEvent(
            runId: "abc",
            seq: 1,
            stream: "tool",
            ts: Date().timeIntervalSince1970 * 1000,
            data: [
                "phase": MoltbotProtocol.AnyCodable("start"),
                "name": MoltbotProtocol.AnyCodable("bash"),
            ],
            summary: nil)
        AgentEventStore.shared.append(sample)
        return AgentEventsWindow()
    }
}
