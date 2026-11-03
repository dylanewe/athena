import { Type, type Static } from 'typebox';
import type { KnowledgeRecord } from './knowledge';

const claimId = Type.String({ pattern: '^K[a-f0-9]{64}$' });
const annotationId = Type.String({ minLength: 36, maxLength: 36, pattern: '^[a-f0-9-]+$' });
const claims = Type.Array(claimId, { minItems: 1, maxItems: 4, uniqueItems: true });
export const resolutionWriteSchema = Type.Union([
  Type.Object({ operation: Type.Literal('annotate'), kind: Type.Union([Type.Literal('intent'), Type.Literal('obsolete-declaration'), Type.Literal('note')]), text: Type.String({ minLength: 1, maxLength: 1000, pattern: '^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$' }), claimIds: claims }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal('reconnect'), id: annotationId, claimIds: claims }, { additionalProperties: false }),
]);
export type ResolutionWrite = Static<typeof resolutionWriteSchema>;
export const resolutionReadSchema = Type.Union([
  Type.Object({ operation: Type.Literal('list'), claimId: Type.Optional(claimId), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal('inspect'), id: annotationId, revision: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })) }, { additionalProperties: false }),
]);
export type ResolutionRead = Static<typeof resolutionReadSchema>;
/** Main-owned snapshots, not renderer/model IDs. Provenance permits access checks after a rebuild. */
export interface ResolutionTarget {
  generation: string;
  version: string;
  record: KnowledgeRecord;
}
export type ResolutionStatus = 'recorded-for-these-versions' | 'requires-reconsideration' | 'requires-reconnection';
export interface ResolutionSummary {
  id: string;
  kind: 'intent' | 'obsolete-declaration' | 'note';
  text: string;
  author: 'user';
  status: ResolutionStatus;
  revision: number;
  versions: { claimId: string; version: string }[];
}
export interface ResolutionView extends ResolutionSummary {
  /** Metadata-only local reconciliation entry; no retained contents authorized. */
  unavailable?: boolean;
  createdAt: string;
  confirmedAt: string;
  bindings: { claimId: string; version: string; scope: string; topic: string; claim: string; provenance: KnowledgeRecord['provenance']; perspective: KnowledgeRecord['perspective']; freshness: 'current' | 'stale'; evidence: { citation: KnowledgeRecord['evidence'][number]['citation']; excerpt: string }[] }[];
}
export interface ResolutionResult { items: ResolutionView[]; nextOffset?: number; notice: string }
export interface ResolutionBridge {
  read(request: ResolutionRead): Promise<ResolutionResult>;
  write(request: ResolutionWrite): Promise<ResolutionResult>;
}
