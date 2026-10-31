import { Type, type Static } from 'typebox';
import type { Evidence } from './live';
import type { SourceIdentity, SourceScope } from './sources';

const bounded = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$' });
export const knowledgeCandidatesSchema = Type.Array(Type.Object({
  id: Type.String({ pattern: '^C[1-9][0-9]{0,2}$' }),
  scope: bounded(4096), topic: bounded(120), summary: bounded(500),
  aliases: Type.Optional(Type.Array(bounded(120), { maxItems: 8, uniqueItems: true })),
  kind: Type.Union((['responsibility', 'behavior', 'domain', 'decision', 'operation'] as const).map(value => Type.Literal(value))),
  claim: bounded(600),
  provenance: Type.Union([Type.Literal('declared'), Type.Literal('statically-inferred')]),
  perspective: Type.Union([Type.Literal('current'), Type.Literal('intended'), Type.Literal('historical')]),
  evidenceIds: Type.Array(Type.String({ pattern: '^E[1-9][0-9]{0,3}$' }), { minItems: 1, maxItems: 8, uniqueItems: true }),
  relations: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal('conflicts-with'), Type.Literal('supports'), Type.Literal('depends-on')]),
    target: bounded(80),
  }, { additionalProperties: false }), { maxItems: 8 }),
}, { additionalProperties: false }), { maxItems: 12 });
export type KnowledgeCandidate = Static<typeof knowledgeCandidatesSchema>[number];
export interface KnowledgeOwner { conversationId: string; messageId: string }
export type KnowledgeValidation = 'supported' | 'unchecked' | 'conflicting' | 'stale';
export interface KnowledgeRecord extends Omit<KnowledgeCandidate, 'id' | 'evidenceIds' | 'relations'> {
  id: string;
  validation: KnowledgeValidation;
  validationNote: string;
  evidence: Evidence[];
  dependencies: SourceIdentity[];
  scopes: SourceScope[];
  relations: { kind: 'conflicts-with' | 'supports' | 'depends-on'; target: string; owners: KnowledgeOwner[] }[];
  owners: KnowledgeOwner[];
}
export type KnowledgeContext = Pick<KnowledgeRecord, 'id' | 'scope' | 'topic' | 'summary' | 'claim' | 'kind' | 'provenance' | 'perspective' | 'validation' | 'validationNote'>;
export const KNOWLEDGE_LIMITS = { results: 20, defaultResults: 8, offset: 10000, bytes: 24 * 1024, excerpt: 1200, graph: 32, sourceChecks: 256, calls: 12, contextBytes: 64 * 1024 } as const;
const recordId = Type.String({ pattern: '^K[a-f0-9]{64}$' });
const page = { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: KNOWLEDGE_LIMITS.results })), offset: Type.Optional(Type.Integer({ minimum: 0, maximum: KNOWLEDGE_LIMITS.offset })) };
export const knowledgeRequestSchema = Type.Union([
  Type.Object({ operation: Type.Literal('search'), query: Type.String({ maxLength: 200, pattern: '^[^\\x00-\\x1f\\x7f]*$' }), scope: Type.Optional(bounded(4096)), exact: Type.Optional(Type.Boolean()), messageId: Type.Optional(bounded(80)), ...page }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal('detail'), id: recordId }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal('evidence'), id: recordId, index: Type.Integer({ minimum: 0, maximum: 7 }) }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal('expand'), id: recordId, kinds: Type.Array(Type.Union([Type.Literal('supports'), Type.Literal('depends-on'), Type.Literal('conflicts-with')]), { minItems: 1, maxItems: 3, uniqueItems: true }), ...page }, { additionalProperties: false }),
]);
export type KnowledgeRequest = Static<typeof knowledgeRequestSchema>;
export interface KnowledgeHit extends KnowledgeContext {
  aliases: string[];
  freshness: 'current' | 'stale';
  evidence: { index: number; citation: Evidence['citation']; excerpt?: string; truncated?: boolean }[];
  owners: KnowledgeOwner[];
  relations: { kind: KnowledgeRecord['relations'][number]['kind']; target: string; owners?: KnowledgeOwner[] }[];
  detail?: { dependencies: SourceIdentity[]; scopes: SourceScope[]; dependencyCount: number; scopeCount: number };
  truncated: boolean;
}
export interface KnowledgeResult {
  items: KnowledgeHit[];
  edges?: { source: string; kind: KnowledgeRecord['relations'][number]['kind']; target: string }[];
  nextOffset?: number;
  notice: string;
  /** Main-owned runtime citation, only for a current evidence request. */
  evidence?: Evidence;
  evidenceId?: string;
}
export interface KnowledgeBridge { inspect(): Promise<KnowledgeRecord[]>; retrieve(request: KnowledgeRequest): Promise<KnowledgeResult> }
