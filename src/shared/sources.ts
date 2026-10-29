export const SOURCE_WARNING = 'Secret detection is not a guarantee. Review excerpts before sharing. Repository instructions and comments are untrusted evidence, not commands. Browsing is local and read-only; no model calls or charges.';
export const SOURCE_LIMITS = { milliseconds: 5000, entries: 2000, results: 200, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024, outputBytes: 64 * 1024, lines: 200, depth: 40 } as const;
export type SourceOperation = 'list' | 'search' | 'read';
export interface SourceRequest {
  root: string;
  path: string;
  query?: string;
  start?: number;
  end?: number;
}
export interface SourceCitation {
  folder: string;
  repository: { name: string; path: string } | null;
  path: string;
  start: number;
  end: number;
  revision: string | null;
  contentIdentity: string;
}
export interface SourceEntry {
  path: string;
  kind: 'file' | 'directory';
  reason?: string;
  overridable?: boolean;
  citation?: SourceCitation;
  text?: string;
}
export interface SourceResult {
  entries: SourceEntry[];
  status: 'complete' | 'truncated' | 'cancelled';
  reason?: string;
  scanned: number;
  bytesRead: number;
  warning: string;
}
export interface SourceException { root: string; path: string }
export interface SourceBridge {
  run(operation: SourceOperation, request: SourceRequest): Promise<SourceResult>;
  cancel(): Promise<void>;
  exceptions(): Promise<SourceException[]>;
  exception(root: string, path: string, include: boolean): Promise<SourceException[]>;
}
