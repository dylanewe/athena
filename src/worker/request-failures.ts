/** An explicit provider error must not be overridden by a proxy's transient-looking HTTP status. */
export function transientHttpFailure(status: number, body: unknown, transientCodes: ReadonlySet<string>): boolean {
  if (![500, 502, 503, 504].includes(status)) return false;
  const error = body && typeof body === 'object' ? (body as Record<string, unknown>).error : undefined;
  if (error === undefined) return true; // Unclassified gateway failure.
  const codes = typeof error === 'string' ? [error] : error && typeof error === 'object'
    ? [(error as Record<string, unknown>).code, (error as Record<string, unknown>).type].filter((code): code is string => typeof code === 'string') : [];
  // Unknown classifications fail closed; no parsing or guessing from provider error prose.
  return codes.length > 0 && codes.every(code => transientCodes.has(code));
}
