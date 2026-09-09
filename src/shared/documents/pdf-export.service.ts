import { once } from 'node:events';
import type { Writable } from 'node:stream';

import PDFDocument from 'pdfkit';

import type { CellValue, ExportColumn, RowSource } from './export.types';

const MARGIN = 40;
const FONT_SIZE = 8;
const HEADER_FONT_SIZE = 9;
const ROW_HEIGHT = 16;
const COLUMN_GAP = 6;

/**
 * A PDF is a human artefact: it is opened, read and filed, not parsed. Past a few thousand
 * lines nobody reads it and the layout engine holds the whole document in memory, so the cap is
 * real rather than defensive. The unbounded export is the CSV one, which streams.
 */
export const MAX_PDF_ROWS = 5_000;

export interface PdfDocumentOptions {
  title: string;
  /** Rendered under the title: the account, the period, whatever identifies the document. */
  subtitle?: string;
  /** Repeated at the foot of every page, next to the page number. */
  footer?: string;
}

function toCell(value: CellValue): string {
  if (value === null) {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace('T', ' ');
  }

  return String(value);
}

/**
 * The kit shipped `pdfkit` and its types but no service to go with them, so every project that
 * needed a printable document wrote this file again. It mirrors `CsvExportService`: same
 * `RowSource`, same `ExportColumn`, so one query feeds both formats.
 */
export class PdfExportService {
  async stream<TRow>(
    rows: RowSource<TRow>,
    columns: readonly ExportColumn<TRow>[],
    out: Writable,
    options: PdfDocumentOptions,
  ): Promise<void> {
    const document = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });

    document.pipe(out);

    const widths = this.resolveWidths(document, columns);

    document.fontSize(16).font('Helvetica-Bold').text(options.title);

    if (options.subtitle !== undefined) {
      document.moveDown(0.2).fontSize(9).font('Helvetica').text(options.subtitle);
    }

    document.moveDown(0.8);
    this.writeHeader(document, columns, widths);

    let written = 0;

    for await (const row of rows) {
      if (written >= MAX_PDF_ROWS) {
        break;
      }

      // A page break has to redraw the header, or every page after the first is a wall of
      // numbers with nothing saying which column is which.
      if (document.y + ROW_HEIGHT > document.page.height - MARGIN * 2) {
        document.addPage();
        this.writeHeader(document, columns, widths);
      }

      this.writeRow(
        document,
        columns.map((column) => toCell(column.value(row))),
        widths,
      );
      written += 1;
    }

    if (written === 0) {
      document.moveDown(0.5).fontSize(FONT_SIZE).font('Helvetica-Oblique');
      document.text('No entries for this period.');
    }

    this.writeFooters(document, options.footer);
    document.end();

    // `end()` only asks pdfkit to flush; the bytes are still on their way to `out`. Resolving
    // before they land would let a caller close the response mid-document.
    await once(out, 'finish');
  }

  private resolveWidths<TRow>(
    document: PDFKit.PDFDocument,
    columns: readonly ExportColumn<TRow>[],
  ): number[] {
    const available = document.page.width - MARGIN * 2 - COLUMN_GAP * (columns.length - 1);
    const declared = columns.reduce((total, column) => total + (column.width ?? 0), 0);

    if (declared <= 0) {
      return columns.map(() => available / columns.length);
    }

    // The declared widths are treated as proportions rather than points, so the same column
    // definitions lay out correctly on A4 here and in a spreadsheet there.
    return columns.map((column) => ((column.width ?? 0) / declared) * available);
  }

  private writeHeader<TRow>(
    document: PDFKit.PDFDocument,
    columns: readonly ExportColumn<TRow>[],
    widths: readonly number[],
  ): void {
    document.fontSize(HEADER_FONT_SIZE).font('Helvetica-Bold');
    this.writeCells(
      document,
      columns.map((column) => column.header),
      widths,
    );

    const y = document.y + 2;
    document
      .moveTo(MARGIN, y)
      .lineTo(document.page.width - MARGIN, y)
      .strokeColor('#999999')
      .lineWidth(0.5)
      .stroke();
    document.y = y + 4;
  }

  private writeRow(
    document: PDFKit.PDFDocument,
    cells: readonly string[],
    widths: readonly number[],
  ): void {
    document.fontSize(FONT_SIZE).font('Helvetica').fillColor('black');
    this.writeCells(document, cells, widths);
  }

  private writeCells(
    document: PDFKit.PDFDocument,
    cells: readonly string[],
    widths: readonly number[],
  ): void {
    const top = document.y;
    let x = MARGIN;

    for (const [index, cell] of cells.entries()) {
      const width = widths[index] ?? 0;

      document.text(cell, x, top, { width, height: ROW_HEIGHT, lineBreak: false, ellipsis: true });
      x += width + COLUMN_GAP;
    }

    document.x = MARGIN;
    document.y = top + ROW_HEIGHT;
  }

  /**
   * Written at the end over the buffered pages, because "page 1 of 7" is not knowable until the
   * seventh page exists.
   */
  private writeFooters(document: PDFKit.PDFDocument, footer: string | undefined): void {
    const range = document.bufferedPageRange();

    for (let page = 0; page < range.count; page += 1) {
      document.switchToPage(range.start + page);
      document.fontSize(7).font('Helvetica').fillColor('#666666');
      document.text(
        `${footer === undefined ? '' : `${footer} — `}page ${page + 1} of ${range.count}`,
        MARGIN,
        document.page.height - MARGIN,
        { width: document.page.width - MARGIN * 2, align: 'center', lineBreak: false },
      );
    }
  }
}
