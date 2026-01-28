import SwiftUI

extension CronSettings {
    var selectedJob: CronJob? {
        guard let id = self.store.selectedJobId else { return nil }
        return self.store.jobs.first(where: { $0.id == id })
    }

    func statusTint(_ status: String?) -> Color {
        switch (status ?? "").lowercased() {
        case "ok": .green
        case "error": .red
        case "skipped": .orange
        default: .secondary
        }
    }

    func scheduleSummary(_ schedule: CronSchedule) -> String {
        switch schedule {
        case let .at(atMs):
            let date = Date(timeIntervalSince1970: TimeInterval(atMs) / 1000)
            return "at \(date.formatted(date: .abbreviated, time: .standard))"
        case let .every(everyMs, _):
            return "every \(self.formatDuration(ms: everyMs))"
        case let .cron(expr, tz):
            if let tz, !tz.isEmpty { return "cron \(expr) (\(tz))" }
            return "cron \(expr)"
        }
    }

    func formatDuration(ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let s = Double(ms) / 1000.0
        if s < 60 { return "\(Int(round(s)))s" }
        let m = s / 60.0
        if m < 60 { return "\(Int(round(m)))m" }
        let h = m / 60.0
        if h < 48 { return "\(Int(round(h)))h" }
        let d = h / 24.0
        return "\(Int(round(d)))d"
    }

    func nextRunLabel(_ date: Date, now: Date = .init()) -> String {
        let delta = date.timeIntervalSince(now)
        if delta <= 0 { return "due" }
        if delta < 60 { return "in <1m" }
        let minutes = Int(round(delta / 60))
        if minutes < 60 { return "in \(minutes)m" }
        let hours = Int(round(Double(minutes) / 60))
        if hours < 48 { return "in \(hours)h" }
        let days = Int(round(Double(hours) / 24))
        return "in \(days)d"
    }
}
