const stampFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Long form for validity and opening times, e.g. "MON, OCT 5, 05:25 PM". */
export function formatStamp(epochMs: number): string {
  return stampFormat.format(new Date(epochMs)).toUpperCase();
}

// Short, receipt-style print time for the header, e.g. "05 OCT 17:26".
const printFormat = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatPrintTime(epochMs: number): string {
  return printFormat.format(new Date(epochMs)).replace(",", "").toUpperCase();
}

/** "32 KB" for limits, "0.4 KB" for sizes. */
export function formatKilobytes(bytes: number): string {
  const kb = bytes / 1024;
  return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
}

export function formatLines(count: number): string {
  return `${count} ${count === 1 ? "LINE" : "LINES"}`;
}
