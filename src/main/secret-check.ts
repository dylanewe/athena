/** No matched values or source text may appear in errors or ordinary logs. */
export function suspectedSecret(text: string): boolean {
  if (/-----BEGIN (?:[A-Z ]*PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(text) ||
      /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text) ||
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(text) ||
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text) ||
      /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:]{1,256}:[^\s/@]{1,256}@/i.test(text)) return true;
  // Lookahead permits nested assignments inside strings (e.g. JSON message content).
  const assignments = /(?=["']?\b([\w.-]{1,128})["']?\s{0,64}[:=]\s{0,64}["']?([^\s"',;\r\n}]{1,512}))/g;
  for (const match of text.matchAll(assignments)) {
    if (!/(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)$/i.test(match[1])) continue;
    const value = match[2];
    // Explicit placeholders are useful in examples, but real values in examples are not exempt.
    if (!/^(?:\$\{|\$[A-Z_]|<|\{\{|process\.env\.|import\.meta\.env\.)/.test(value) &&
        !/^(?:example|placeholder|changeme|change-me|your[-_].*|xxx+|redacted|dummy|test|true|false|null|undefined|none)$/i.test(value)) return true;
  }
  return false;
}

/** Values stay memory-only; callers must not use this as a durable redaction policy. */
export function environmentValues(text: string): string[] {
  const values = new Set([text]);
  for (const line of text.split(/\r?\n/)) {
    values.add(line);
    const value = /^\s*(?:export\s+)?[\w.-]+\s*=\s*(.*?)\s*$/.exec(line)?.[1];
    if (value) values.add(value.replace(/^(['"])([\s\S]*)\1$/, '$2'));
  }
  return [...values].filter(value => value.trim());
}

/** Call at the final model-request boundary, including composed context and tool outputs. */
export function checkBeforeModelSend(material: unknown): void {
  const serialized = JSON.stringify(material);
  if (serialized && suspectedSecret(serialized.replace(/\\"/g, '"').replace(/\\n/g, '\n'))) {
    throw new Error('Model request blocked: suspected secret. Detection is not a guarantee.');
  }
}
