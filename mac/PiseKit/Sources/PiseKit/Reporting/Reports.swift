import Foundation

enum UsageRange: String, CaseIterable, Sendable {
    case today = "Today", week = "Week", month = "Month"

    func start(now: Date, calendar: Calendar) -> Date {
        let day = calendar.startOfDay(for: now)
        switch self {
        case .today: return day
        case .week:
            let weekday = calendar.component(.weekday, from: day)
            return calendar.date(byAdding: .day, value: -((weekday + 5) % 7), to: day)!
        case .month:
            return calendar.date(from: calendar.dateComponents([.era, .year, .month], from: day))!
        }
    }
}

enum UsageMetric: String, CaseIterable, Sendable {
    case cost = "Estimated cost", tokens = "Tokens"
    func value(_ totals: UsageTotals) -> Double { self == .cost ? totals.cost : totals.tokens }
}

struct ReportQuery: Equatable, Sendable {
    var range: UsageRange = .today
    var metric: UsageMetric = .cost
    var project: String?
    var model: String?
    var branch: String?
    var tag: String?

    var hasUsageFilters: Bool { model != nil || branch != nil || tag != nil }
    var hasFilters: Bool { project != nil || hasUsageFilters }
}

struct UsageTotals: Equatable, Sendable {
    var calls = 0
    var tokens = 0.0
    var input = 0.0
    var output = 0.0
    var cacheRead = 0.0
    var cacheWrite = 0.0
    var cost = 0.0
    var costedCalls = 0
    var unidentifiedCalls = 0
    private var sessionKeys: Set<String> = []
    var sessions: Int { sessionKeys.count }
    var estimatedCost: Double? { costedCalls > 0 ? cost : nil }

    mutating func add(_ record: UsageRecord) {
        calls += 1
        tokens += record.usage.totalTokens
        input += record.usage.input
        output += record.usage.output
        cacheRead += record.usage.cacheRead
        cacheWrite += record.usage.cacheWrite
        if let cost = record.usage.totalCost { self.cost += cost; costedCalls += 1 }
        if let key = record.sessionFile, !key.isEmpty { sessionKeys.insert(key) }
        else { unidentifiedCalls += 1 }
    }
}

struct UsageRow: Equatable, Identifiable, Sendable {
    var id: String
    var label: String
    var totals = UsageTotals()
}

struct DailyUsage: Equatable, Identifiable, Sendable {
    var id: Date
    var totals = UsageTotals()
}

struct SkillTotals: Equatable, Sendable {
    var events = 0
    var commands = 0
    var reads = 0
    var unidentifiedEvents = 0
    private var sessionKeys: Set<String> = []
    var sessions: Int { sessionKeys.count }

    mutating func add(_ record: SkillRecord) {
        events += 1
        if record.trigger == "skill-command" { commands += 1 } else { reads += 1 }
        if let key = record.sessionKey { sessionKeys.insert(key) } else { unidentifiedEvents += 1 }
    }
}

struct SkillRow: Equatable, Identifiable, Sendable {
    var id: String
    var totals = SkillTotals()
    var projects: Set<String> = []
}

struct ProjectOption: Equatable, Identifiable, Sendable {
    var id: String
    var label: String
}

struct DashboardReport: Equatable, Sendable {
    var query = ReportQuery()
    var usageStatus = LedgerStatus()
    var skillStatus = LedgerStatus()
    var loadedAt: Date?
    var computedAt = Date()
    var totals = UsageTotals()
    var projects: [UsageRow] = []
    var models: [UsageRow] = []
    var branches: [UsageRow] = []
    var tags: [UsageRow] = []
    var days: [DailyUsage] = []
    var skills: [SkillRow] = []
    var skillProjects: [SkillRow] = []
    var skillTotals = SkillTotals()
    var projectOptions: [ProjectOption] = []
    var modelOptions: [String] = []
    var branchOptions: [String] = []
    var tagOptions: [String] = []
}

enum Reports {
    static func build(_ snapshot: LedgerSnapshot, query: ReportQuery, now: Date = Date(),
                      calendar: Calendar = .current) throws -> DashboardReport {
        let start = query.range.start(now: now, calendar: calendar)
        var report = DashboardReport(query: query, usageStatus: snapshot.usage.status,
                                     skillStatus: snapshot.skills.status, loadedAt: snapshot.loadedAt,
                                     computedAt: now)
        var projectOptions: [String: String] = [:]
        var projects: [String: UsageRow] = [:]
        var models: [String: UsageRow] = [:]
        var branches: [String: UsageRow] = [:]
        var tags: [String: UsageRow] = [:]
        var days: [Date: DailyUsage] = [:]
        var modelOptions: Set<String> = []
        var branchOptions: Set<String> = []
        var tagOptions: Set<String> = []

        var day = start
        while day <= now {
            days[day] = DailyUsage(id: day)
            guard let next = calendar.date(byAdding: .day, value: 1, to: day), next > day else { break }
            day = next
        }
        for (index, record) in snapshot.usage.records.enumerated() {
            if index % 256 == 0 { try Task.checkCancellation() }
            projectOptions[record.projectKey] = record.project.label(cwd: record.cwd)
            guard record.timestamp >= start && record.timestamp <= now else { continue }
            guard query.project == nil || record.projectKey == query.project else { continue }
            modelOptions.insert(record.modelKey)
            // Branches are meaningful only in a project. Options ignore usage-only
            // filters so changing a selection cannot trap the picker on one value.
            if query.project != nil { branchOptions.insert(record.branch) }
            tagOptions.formUnion(record.tags ?? [])
            guard query.model == nil || query.model == record.modelKey,
                  query.branch == nil || query.branch == record.branch,
                  query.tag == nil || (record.tags ?? []).contains(query.tag!) else { continue }
            report.totals.add(record)
            add(record, key: record.projectKey, label: record.project.label(cwd: record.cwd), to: &projects)
            add(record, key: record.modelKey, label: record.modelKey, to: &models)
            if query.project != nil { add(record, key: record.branch, label: record.branch, to: &branches) }
            for tag in Set(record.tags ?? []) { add(record, key: tag, label: tag, to: &tags) }
            let day = calendar.startOfDay(for: record.timestamp)
            days[day, default: DailyUsage(id: day)].totals.add(record)
        }
        report.projects = sorted(projects, metric: query.metric)
        report.models = sorted(models, metric: query.metric)
        report.branches = sorted(branches, metric: query.metric)
        report.tags = sorted(tags, metric: query.metric)
        report.days = days.values.sorted { $0.id < $1.id }
        report.modelOptions = modelOptions.sorted()
        report.branchOptions = branchOptions.sorted()
        report.tagOptions = tagOptions.sorted()

        var skills: [String: SkillRow] = [:]
        var skillProjects: [String: SkillRow] = [:]
        for (index, record) in snapshot.skills.records.enumerated() {
            if index % 256 == 0 { try Task.checkCancellation() }
            projectOptions[record.projectKey] = record.projectLabel
            guard record.timestamp >= start && record.timestamp <= now,
                  query.project == nil || query.project == record.projectKey else { continue }
            report.skillTotals.add(record)
            var skill = skills[record.skill.name, default: SkillRow(id: record.skill.name)]
            skill.totals.add(record)
            skill.projects.insert(record.projectKey)
            skills[record.skill.name] = skill
            var project = skillProjects[record.projectKey, default: SkillRow(id: record.projectKey)]
            project.totals.add(record)
            project.projects.insert(record.skill.name)
            skillProjects[record.projectKey] = project
        }
        report.skills = skills.values.sorted { $0.totals.events == $1.totals.events ? $0.id < $1.id : $0.totals.events > $1.totals.events }
        report.skillProjects = skillProjects.values.sorted { $0.totals.events == $1.totals.events ? $0.id < $1.id : $0.totals.events > $1.totals.events }
        // Include historical projects so a zero-activity selection remains legible.
        let labelCounts = Dictionary(grouping: projectOptions.values, by: { $0 }).mapValues(\.count)
        report.projectOptions = projectOptions.map { key, label in
            let display = (labelCounts[label] ?? 0) > 1 ? key.split(separator: "/").suffix(2).joined(separator: "/") : label
            return ProjectOption(id: key, label: display)
        }.sorted { $0.id < $1.id }
        return report
    }

    private static func add(_ record: UsageRecord, key: String, label: String, to rows: inout [String: UsageRow]) {
        var row = rows[key, default: UsageRow(id: key, label: label)]
        row.totals.add(record)
        rows[key] = row
    }

    private static func sorted(_ rows: [String: UsageRow], metric: UsageMetric) -> [UsageRow] {
        rows.values.sorted {
            let left = metric.value($0.totals), right = metric.value($1.totals)
            return left == right ? $0.id < $1.id : left > right
        }
    }
}
