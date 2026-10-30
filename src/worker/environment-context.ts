import { checkBeforeModelSend, environmentValues } from '../main/secret-check';
import type { SourceResult } from '../shared/sources';

/** Per-worker, memory-only exception to final secret checks for exact approved values.
 * Ordinary source files still pass full-file checks in main. Never a persistence filter:
 * ALL output from an exposed context is withheld from durable state, even paraphrases.
 */
export class EnvironmentContext {
  private readonly values = new Set<string>();
  observe(result: SourceResult): void {
    for (const entry of result.entries) {
      if (!entry.ephemeral || entry.text === undefined) continue;
      for (const value of environmentValues(entry.text)) this.values.add(value);
    }
  }
  check = (material: unknown): void => {
    let serialized = JSON.stringify(material);
    if (!serialized) return;
    // Pi serializes JSON tool results inside JSON strings. Cover nested escaping
    // without weakening checks for values from any unapproved source.
    const fragments = new Set<string>();
    for (const value of this.values) {
      if (!value) continue;
      let fragment = value;
      for (let depth = 0; depth < 5; depth++) {
        fragments.add(fragment); fragment = JSON.stringify(fragment).slice(1, -1);
      }
    }
    for (const fragment of [...fragments].sort((a, b) => b.length - a.length)) serialized = serialized.split(fragment).join('redacted');
    checkBeforeModelSend(serialized);
  };
}
