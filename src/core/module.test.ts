import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '@core/errors/app-error';
import type { AppModule } from '@core/module';
import { selectModules } from '@core/module';

const modules: AppModule[] = [
  { name: 'health', controllers: [] },
  { name: 'notification', controllers: [] },
];

describe('selectModules', () => {
  it('returns every module for the wildcard', () => {
    expect(selectModules(modules, ['*']).map((m) => m.name)).toEqual(['health', 'notification']);
  });

  it('keeps only the enabled modules', () => {
    expect(selectModules(modules, ['health']).map((m) => m.name)).toEqual(['health']);
  });

  it('fails fast on an unknown module name', () => {
    expect(() => selectModules(modules, ['health', 'ghost'])).toThrow(ConfigurationError);
    expect(() => selectModules(modules, ['ghost'])).toThrow(/ghost/);
  });
});
