import SwiftUI

// Benign status-string switch distilled from a real menu view. The
// "ok-token" case is a heartbeat status literal, not a credential; a
// deleted file containing it must stay reviewable without redaction.
struct HeartbeatStatusView: View {
    let store: HeartbeatStore

    var heartbeatStatus: (label: String, color: Color) {
        if let evt = store.lastEvent {
            let ageText = age(from: Date(timeIntervalSince1970: evt.ts / 1000))
            switch evt.status {
            case "sent":
                return ("Last heartbeat sent · \(ageText)", .blue)
            case "ok-empty", "ok-token":
                return ("Heartbeat ok · \(ageText)", .green)
            case "skipped":
                return ("Heartbeat skipped · \(ageText)", .secondary)
            case "failed":
                return ("Heartbeat failed · \(ageText)", .red)
            default:
                return ("Heartbeat · \(ageText)", .secondary)
            }
        }
        return ("No heartbeat yet", .secondary)
    }

    var body: some View {
        Label(heartbeatStatus.label, systemImage: "waveform.path.ecg")
            .foregroundStyle(heartbeatStatus.color)
    }
}
