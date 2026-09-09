import type { Writable } from 'node:stream';

import ExcelJS from 'exceljs';

import type { ExportColumn, RowSource } from './export.types';

export class ExcelExportService {
  /**
   * `WorkbookWriter` commits each row to the output as it is added, so the workbook is never
   * held whole in memory — the same guarantee as the CSV export, in a format accountants open
   * without asking questions.
   */
  async stream<TRow>(
    rows: RowSource<TRow>,
    columns: readonly ExportColumn<TRow>[],
    out: Writable,
    sheetName = 'Export',
  ): Promise<void> {
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: true });
    const sheet = workbook.addWorksheet(sheetName);

    sheet.columns = columns.map((column) => ({
      header: column.header,
      key: column.header,
      width: column.width ?? 20,
    }));
    sheet.getRow(1).font = { bold: true };

    for await (const row of rows) {
      sheet.addRow(columns.map((column) => column.value(row))).commit();
    }

    sheet.commit();
    await workbook.commit();
  }
}
