import sharp from 'sharp';

/**
 * A browser sends whatever Content-Type it likes, and a `.jpg` extension proves nothing, so
 * the type is read from the bytes themselves. An allowlist, not a blocklist: anything not
 * recognised as one of these is refused.
 */
const SIGNATURES: readonly { mime: string; matches: (bytes: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  {
    mime: 'image/webp',
    matches: (b) =>
      b.subarray(0, 4).toString('ascii') === 'RIFF' &&
      b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  { mime: 'image/gif', matches: (b) => b.subarray(0, 4).toString('ascii') === 'GIF8' },
  {
    mime: 'image/avif',
    matches: (b) =>
      b.subarray(4, 8).toString('ascii') === 'ftyp' &&
      ['avif', 'avis'].includes(b.subarray(8, 12).toString('ascii')),
  },
];

export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length < 12) {
    return null;
  }

  return SIGNATURES.find((signature) => signature.matches(bytes))?.mime ?? null;
}

/** Longest edge of each variant. The original is kept untouched alongside them. */
export const IMAGE_VARIANTS = { thumb: 150, small: 480, medium: 1024 } as const;

export type ImageVariant = keyof typeof IMAGE_VARIANTS;

export interface RenderedVariant {
  variant: ImageVariant;
  body: Buffer;
  contentType: string;
}

/**
 * WebP for every variant: it is a third of the weight of the JPEG at equal quality, which on a
 * mobile connection in Cotonou is the difference between a page that loads and one that does not.
 *
 * sharp drops metadata unless asked to keep it, so the GPS coordinates a phone writes into a
 * photo never reach the bucket — a privacy default, not an optimisation.
 */
export async function renderVariants(original: Buffer): Promise<RenderedVariant[]> {
  const entries = Object.entries(IMAGE_VARIANTS) as [ImageVariant, number][];

  return Promise.all(
    entries.map(async ([variant, size]) => ({
      variant,
      contentType: 'image/webp',
      body: await sharp(original)
        // Rotating by the EXIF orientation before stripping it is what keeps a portrait photo
        // from coming back sideways once the metadata is gone.
        .rotate()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer(),
    })),
  );
}
