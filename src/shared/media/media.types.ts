export const MEDIA_STATUSES = ['pending', 'ready', 'failed'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** Variant name → storage key. Empty until the processing job has run. */
export type MediaVariants = Record<string, string>;

export interface Media {
  id: string;
  ownerType: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
  status: MediaStatus;
  variants: MediaVariants;
  createdAt: Date;
}

export interface MediaUrls {
  original: string;
  variants: Record<string, string>;
}
