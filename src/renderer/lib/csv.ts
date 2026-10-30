/** Minimal, safe CSV builder (pure, unit tested). Exports only what is already on screen. */
export type CsvCell = string | number | null | undefined;

// Spreadsheet formula injection: a cell that starts with = + - @ (or a tab/CR) is prefixed with an apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // negative numbers are numbers, not formulas
  if (typeof value === "string" && FORMULA_START.test(text)) text = "'" + text;
  return /[",\r\n;]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function toCsv(rows: CsvCell[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
