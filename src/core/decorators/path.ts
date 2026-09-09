export function normalizePath(path: string): string {
  const trimmed = path.trim();
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');

  return withoutTrailingSlash === '' ? '/' : withoutTrailingSlash;
}

export function joinPaths(basePath: string, path: string): string {
  const base = normalizePath(basePath);
  const suffix = normalizePath(path);

  if (suffix === '/') {
    return base;
  }
  if (base === '/') {
    return suffix;
  }

  return `${base}${suffix}`;
}
