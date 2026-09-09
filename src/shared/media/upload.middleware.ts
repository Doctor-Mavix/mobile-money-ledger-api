import type { RequestHandler } from 'express';
import multer, { MulterError } from 'multer';

import { env } from '@core/config/env';
import type { AppError } from '@core/errors/app-error';
import { BadRequestError, PayloadTooLargeError } from '@core/errors/app-error';

function toAppError(error: MulterError): AppError {
  if (error.code === 'LIMIT_FILE_SIZE') {
    return new PayloadTooLargeError(
      `This file exceeds the ${String(env.MEDIA_MAX_UPLOAD_BYTES)} byte limit`,
      { cause: error },
    );
  }

  return new BadRequestError(error.message, { cause: error });
}

/**
 * Memory storage on purpose: the bytes go straight to object storage, so writing them to the
 * container's disk first would only add a round trip and a file to clean up — and on several
 * replicas that file would land on whichever instance served the request.
 *
 * The size limit is stated here as well as in `MediaService` so an oversized upload is cut off
 * mid-stream instead of being buffered whole and then rejected.
 */
export function singleFileUpload(field: string): RequestHandler {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.MEDIA_MAX_UPLOAD_BYTES, files: 1 },
  }).single(field);

  return (req, res, next) => {
    upload(req, res, (error: unknown) => {
      // Multer reports its own failures as MulterError, which the error middleware would
      // otherwise turn into an opaque 500. Core knows nothing about multer, so the mapping
      // belongs here.
      next(error instanceof MulterError ? toAppError(error) : error);
    });
  };
}
