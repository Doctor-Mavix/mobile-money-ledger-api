import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';

import { format } from 'fast-csv';

import type { CellValue, ExportColumn, RowSource } from './export.types';

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function toCell(value: CellValue): string | number | boolean {
  if (value === null) {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  // Excel and LibreOffice evaluate a cell that opens with = + - @ as a formula. A user-supplied
  // field is therefore enough to build a spreadsheet that runs when an agent opens the export,
  // so the value is quoted into an inert string. The xlsx writer needs no equivalent: there a
  // formula is a distinct cell type, not a matter of the first character.
  return typeof value === 'string' && FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

export class CsvExportService {
  /**
   * `pipeline` is what makes this safe under backpressure: a client downloading slowly slows
   * the database cursor down with it instead of filling the process with buffered rows.
   */
  async stream<TRow>(
    rows: RowSource<TRow>,
    columns: readonly ExportColumn<TRow>[],
    out: Writable,
  ): Promise<void> {
    await pipeline(
      async function* () {
        for await (const row of rows) {
          yield columns.map((column) => toCell(column.value(row)));
        }
      },
      // A BOM is what stops Excel on Windows from rendering "Cotonou" as mojibake.
      format({ headers: columns.map((column) => column.header), writeBOM: true }),
      out,
    );
  }
}
