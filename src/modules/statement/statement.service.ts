import type { Writable } from 'node:stream';

import { BadRequestError } from '@core/errors/app-error';
import type { LedgerRepository } from '@modules/ledger/ledger.repository';
import type { StatementEntry } from '@modules/ledger/ledger.types';
import type { WalletService } from '@modules/wallet/wallet.service';
import type { Wallet } from '@modules/wallet/wallet.types';
import type { CsvExportService } from '@shared/documents/csv-export.service';
import type { ExportColumn } from '@shared/documents/export.types';
import type { PdfExportService } from '@shared/documents/pdf-export.service';
import { formatMoney } from '@shared/money/money';

export const STATEMENT_FORMATS = ['csv', 'pdf'] as const;

export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

/**
 * A statement is a legal-ish document about a period, so the period is bounded: an unbounded
 * range would let one request walk the whole table, and no account holder needs eleven years
 * in one file.
 */
const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface StatementRequest {
  actorId: string;
  walletId: string;
  from: Date;
  to: Date;
  format: StatementFormat;
}

export interface StatementDelivery {
  filename: string;
  contentType: string;
}

export interface StatementServiceOptions {
  ledger: LedgerRepository;
  wallets: WalletService;
  csv: CsvExportService;
  pdf: PdfExportService;
}

const CONTENT_TYPES: Record<StatementFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

export class StatementService {
  private readonly options: StatementServiceOptions;

  constructor(options: StatementServiceOptions) {
    this.options = options;
  }

  describe(request: StatementRequest): StatementDelivery {
    const period = `${this.day(request.from)}_${this.day(request.to)}`;

    return {
      filename: `statement_${request.walletId}_${period}.${request.format}`,
      contentType: CONTENT_TYPES[request.format],
    };
  }

  /**
   * Resolves the wallet and the period before a single byte is written. Once the response has
   * started there is no way to turn it into a 404, so everything that can refuse has to refuse
   * first.
   */
  async prepare(request: StatementRequest): Promise<Wallet> {
    if (request.to < request.from) {
      throw new BadRequestError('"to" must not be earlier than "from"');
    }

    if (request.to.getTime() - request.from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new BadRequestError(`A statement covers at most ${MAX_RANGE_DAYS} days`);
    }

    return this.options.wallets.requireOwned(request.actorId, request.walletId);
  }

  async write(wallet: Wallet, request: StatementRequest, out: Writable): Promise<void> {
    const rows = this.options.ledger.streamRange(wallet.id, {
      from: request.from,
      to: request.to,
    });
    const columns = this.columns(wallet);

    if (request.format === 'csv') {
      await this.options.csv.stream(rows, columns, out);
      return;
    }

    await this.options.pdf.stream(rows, columns, out, {
      title: `Statement — ${wallet.currency} wallet`,
      subtitle:
        `Wallet ${wallet.id} · ${this.day(request.from)} to ${this.day(request.to)} · ` +
        `balance today ${formatMoney(wallet.balance, wallet.currency)}`,
      footer: `Wallet ${wallet.id}`,
    });
  }

  /**
   * Amounts are rendered, not raw: this is the one place the numbers are read by a person, and
   * a column of minor units is a support ticket. The signed amount is split into a debit and a
   * credit column, which is how every bank statement in the world is laid out.
   */
  private columns(wallet: Wallet): ExportColumn<StatementEntry>[] {
    return [
      { header: 'Date', value: (entry) => entry.createdAt, width: 18 },
      { header: 'No', value: (entry) => entry.sequence, width: 6 },
      {
        header: 'Reference',
        // The payer's own words when there are any, the transfer id otherwise: a row always has
        // to be traceable back to a movement, but a UUID is not what the holder wrote.
        value: (entry) => entry.reference ?? entry.transferId,
        width: 30,
      },
      {
        header: 'Debit',
        value: (entry) => (entry.amount < 0n ? formatMoney(-entry.amount, wallet.currency) : ''),
        width: 16,
      },
      {
        header: 'Credit',
        value: (entry) => (entry.amount > 0n ? formatMoney(entry.amount, wallet.currency) : ''),
        width: 16,
      },
      {
        header: 'Balance',
        value: (entry) => formatMoney(entry.balanceAfter, wallet.currency),
        width: 18,
      },
    ];
  }

  private day(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
