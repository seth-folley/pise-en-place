import SwiftUI
import Charts

struct OverviewView: View {
    let report: DashboardReport
    let selectProject: (String) -> Void
    let selectModel: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 8) {
                MetricCard(title: "Estimated USD", value: report.usageStatus.available ? UsageMetric.cost.formatted(report.totals) : "—")
                MetricCard(title: "Tokens", value: report.usageStatus.available ? UsageMetric.tokens.formatted(report.totals) : "—")
                MetricCard(title: "Known sessions", value: report.usageStatus.available ? "\(report.totals.sessions)" : "—")
            }
            LedgerNotices(title: "Usage", status: report.usageStatus)
            if report.usageStatus.available {
                if report.totals.calls == 0 {
                    ContentUnavailableView("No activity in this range", systemImage: "chart.bar", description: Text("Try a different time range or clear your filters."))
                } else {
                    Text("\(report.totals.calls) usage records • estimates available for \(report.totals.costedCalls)")
                        .font(.caption).foregroundStyle(.secondary)
                    if report.totals.unidentifiedCalls > 0 {
                        Text("\(report.totals.unidentifiedCalls) record(s) lack session identity and aren’t counted as sessions.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Daily \(report.query.metric == .cost ? "estimated cost" : "tokens")").font(.headline)
                        Chart(report.days) { day in
                            if report.query.metric == .tokens || day.totals.costedCalls > 0 || day.totals.calls == 0 {
                                BarMark(x: .value("Day", day.id, unit: .day),
                                        y: .value(report.query.metric.rawValue, report.query.metric.value(day.totals)))
                                    .accessibilityLabel(day.id.formatted(date: .abbreviated, time: .omitted))
                                    .accessibilityValue(report.query.metric.accessibleValue(day.totals))
                            }
                        }
                        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 5)) }
                        .frame(height: 140)
                        Text("\(report.days.count) calendar day(s); \(report.query.metric.formatted(report.totals)) recorded in this range.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    UsageRanking(title: "Top projects", rows: Array(report.projects.prefix(5)), metric: report.query.metric, selection: selectProject)
                    UsageRanking(title: "Top models", rows: Array(report.models.prefix(5)), metric: report.query.metric, selection: selectModel)
                }
            }
            Text("* Partial cost: only known estimates are added. Cost rankings use that subtotal; missing estimates can change the order. Pi’s estimates are not your subscription bill.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
