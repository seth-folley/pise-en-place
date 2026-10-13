#if DEBUG
import Foundation

// Previews use synthetic metadata and never open the user's ledgers.
enum PreviewData {
    static var report: DashboardReport {
        let now = Date()
        let calendar = Calendar.current
        let start = UsageRange.week.start(now: now, calendar: calendar)
        let first = LedgerProject(name: "pise-en-place", gitRemote: "github.com/example/pise-en-place", gitRoot: nil,
                                  gitCommonDir: nil, gitBranch: "main")
        let second = LedgerProject(name: "demo-app", gitRemote: "github.com/example/demo-app", gitRoot: nil,
                                   gitCommonDir: nil, gitBranch: "feature/menu")
        let usage = (0..<24).map { index in
            let date = start.addingTimeInterval(now.timeIntervalSince(start) * Double(index) / 24)
            return UsageRecord(version: 1, id: "preview-\(index)", source: "live", timestamp: date,
                               sessionFile: "/synthetic/session-\(index / 4)", cwd: nil,
                               project: index % 3 == 0 ? second : first, tags: [index % 2 == 0 ? "implementation" : "review"],
                               provider: "example", model: index % 3 == 0 ? "fast-model" : "reasoning-model",
                               usage: .init(input: Double(index + 1) * 1200, output: 400, cacheRead: 600,
                                            cacheWrite: 0, totalTokens: Double(index + 1) * 1200 + 1000,
                                            totalCost: index % 5 == 0 ? nil : Double(index + 1) / 20))
        }
        let skills = (0..<12).map { index in
            SkillRecord(version: 1, id: "preview-skill-\(index)", timestamp: now,
                        trigger: index % 3 == 0 ? "skill-command" : "read-tool",
                        sessionFile: "/synthetic/session-\(index / 3)", cwd: nil,
                        project: index % 2 == 0 ? first : second,
                        skill: .init(name: index % 2 == 0 ? "swiftui-expert-skill" : "swift-concurrency"))
        }
        var query = ReportQuery()
        query.range = .week
        let snapshot = LedgerSnapshot(usage: LedgerResult(records: usage), skills: LedgerResult(records: skills), loadedAt: now)
        return try! Reports.build(snapshot, query: query, now: now, calendar: calendar)
    }
}
#endif
