import QRCode from 'qrcode';

export interface QrCodeOptions {
  /** Pixel width of the rendered square. */
  width?: number;
  /** L, M, Q, H — H survives a printed code being partly rubbed out. */
  errorCorrection?: 'L' | 'M' | 'Q' | 'H';
}

const DEFAULTS = { width: 256, errorCorrection: 'M' } as const;

/** TOTP provisioning, payment links, event tickets, printed tracking numbers. */
export class QrCodeService {
  async toPngBuffer(content: string, options: QrCodeOptions = {}): Promise<Buffer> {
    return QRCode.toBuffer(content, {
      type: 'png',
      width: options.width ?? DEFAULTS.width,
      errorCorrectionLevel: options.errorCorrection ?? DEFAULTS.errorCorrection,
    });
  }

  /** Inline `data:image/png;base64,...`, ready to drop into an <img> or an email. */
  async toDataUrl(content: string, options: QrCodeOptions = {}): Promise<string> {
    return QRCode.toDataURL(content, {
      width: options.width ?? DEFAULTS.width,
      errorCorrectionLevel: options.errorCorrection ?? DEFAULTS.errorCorrection,
    });
  }
}
