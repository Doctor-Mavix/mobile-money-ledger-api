export type CellValue = string | number | boolean | Date | null;

export interface ExportColumn<TRow> {
  header: string;
  value: (row: TRow) => CellValue;
  /**
   * A relative weight, not a measurement: Excel reads it as a column width, the PDF writer
   * scales it against the page. Ignored by the CSV writer, which has no layout.
   */
  width?: number;
}

/**
 * Exports read an async iterable, never an array: the whole point is that a 200 000-row export
 * costs one page of memory instead of two hundred thousand rows of it.
 */
export type RowSource<TRow> = AsyncIterable<TRow>;
