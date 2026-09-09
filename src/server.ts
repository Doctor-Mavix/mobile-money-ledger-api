import 'reflect-metadata';

import { EnvValidationError } from '@core/config/env-validation-error';

async function main(): Promise<void> {
  // Imported lazily so a configuration failure is reported before any module is evaluated.
  const { bootstrap } = await import('./bootstrap');
  await bootstrap();
}

try {
  await main();
} catch (error) {
  if (error instanceof EnvValidationError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
}
