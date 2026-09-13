/**
 * 导出打印样式（M97，issue #7 行程导出 PDF）。
 * 以 <style> 标签随导出弹层注入，不走全局 index.css：
 * - 屏幕态：A4 纸张预览（白底卡片 + 灰底）；
 * - 打印态：隐藏应用其余部分（body 直接子节点里只留导出浮层），纸张边距、分页控制。
 * 中英文混排：系统字体栈 + overflow-wrap 防长 URL/英文溢出。
 */
export const EXPORT_BODY_CLASS = "yarnball-export-open";
export const EXPORT_OVERLAY_CLASS = "yarnball-export-overlay";

export const EXPORT_PRINT_CSS = `
.${EXPORT_OVERLAY_CLASS} {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow-y: auto;
  background: #e2e8f0;
}
.ybe-sheet {
  max-width: 820px;
  margin: 24px auto 48px;
  background: #ffffff;
  padding: 44px 52px;
  border-radius: 12px;
  box-shadow: 0 8px 30px rgb(15 23 42 / 0.12);
  color: #0f172a;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Noto Sans CJK SC", "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.65;
  word-break: break-word;
  overflow-wrap: break-word;
}
.ybe-sheet h1 {
  font-size: 22px;
  font-weight: 700;
  margin: 0;
}
.ybe-sub {
  margin-top: 4px;
  color: #475569;
  font-size: 13px;
}
.ybe-section {
  margin-top: 26px;
}
.ybe-section-title {
  font-size: 15px;
  font-weight: 700;
  margin: 0 0 10px;
  padding-bottom: 6px;
  border-bottom: 2px solid #0f172a;
}
.ybe-overview-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px 24px;
  margin-top: 8px;
}
.ybe-overview-grid .ybe-k {
  color: #64748b;
  margin-right: 6px;
}
.ybe-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.ybe-table th {
  text-align: left;
  color: #64748b;
  font-weight: 600;
  padding: 5px 8px;
  border-bottom: 1.5px solid #cbd5e1;
  white-space: nowrap;
}
.ybe-table td {
  padding: 6px 8px;
  border-bottom: 1px solid #e2e8f0;
  vertical-align: top;
}
.ybe-table .ybe-url {
  word-break: break-all;
  font-size: 11.5px;
  color: #334155;
}
.ybe-day {
  margin-top: 18px;
}
.ybe-day-header {
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.ybe-day-stop {
  font-size: 12px;
  font-weight: 600;
  color: #0369a1;
}
/* 每日开头段落：本期放「当晚住宿」一行；后续每日概要/天气/强度（issue #5/#6/#9）落在这里 */
.ybe-day-intro {
  margin-top: 2px;
  font-size: 12px;
  color: #64748b;
}
.ybe-entry {
  display: flex;
  gap: 12px;
  padding: 7px 0 7px 2px;
  border-bottom: 1px dashed #e2e8f0;
}
.ybe-entry:last-child {
  border-bottom: none;
}
.ybe-time {
  flex: none;
  width: 92px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: #0f172a;
  font-size: 12.5px;
}
.ybe-time .ybe-est {
  color: #94a3b8;
  font-weight: 400;
}
.ybe-entry-body {
  min-width: 0;
  flex: 1;
}
.ybe-entry-name {
  font-weight: 600;
}
.ybe-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 11px;
  font-weight: 500;
  vertical-align: 1px;
}
.ybe-tag.ybe-tag-transit {
  background: #e0f2fe;
  color: #0369a1;
}
.ybe-meta {
  margin-top: 1px;
  color: #475569;
  font-size: 12px;
}
.ybe-note {
  margin-top: 2px;
  color: #334155;
  font-size: 12px;
  background: #f8fafc;
  border-left: 2.5px solid #cbd5e1;
  padding: 3px 8px;
}
.ybe-leg {
  display: flex;
  gap: 12px;
  padding: 2px 0 2px 2px;
  color: #94a3b8;
  font-size: 11.5px;
}
.ybe-leg::before {
  content: "";
  flex: none;
  width: 92px;
}
.ybe-empty {
  color: #94a3b8;
  font-size: 12.5px;
  padding: 6px 0;
}
.ybe-footer {
  margin-top: 34px;
  padding-top: 10px;
  border-top: 1px solid #e2e8f0;
  color: #94a3b8;
  font-size: 11px;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

@media print {
  @page {
    margin: 14mm 12mm;
  }
  html,
  body {
    height: auto !important;
    overflow: visible !important;
  }
  /* 只打印导出浮层：应用本体（#root）与 toast 等 body 直接子节点全部隐藏 */
  body.${EXPORT_BODY_CLASS} > :not(.${EXPORT_OVERLAY_CLASS}) {
    display: none !important;
  }
  .${EXPORT_OVERLAY_CLASS} {
    position: static !important;
    overflow: visible !important;
    background: #ffffff !important;
  }
  .${EXPORT_OVERLAY_CLASS} .ybe-toolbar {
    display: none !important;
  }
  .ybe-sheet {
    max-width: none;
    margin: 0;
    padding: 0;
    border-radius: 0;
    box-shadow: none;
    font-size: 12px;
  }
  /* 分页：天/条目/表格行不跨页断开，标题不孤行 */
  .ybe-day,
  .ybe-entry,
  .ybe-table tr,
  .ybe-overview-grid {
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .ybe-day-header,
  .ybe-section-title {
    break-after: avoid;
    page-break-after: avoid;
  }
  .ybe-footer {
    break-inside: avoid;
  }
}
`;
