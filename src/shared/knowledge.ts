import { Type, type Static } from 'typebox';
import type { Evidence } from './live';
import type { SourceIdentity } from './sources';

const bounded = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '^[^\\x00-\\x1f\\x7f]+$' });
export const knowledgeCandidatesSchema = Type.Array(Type.Object({
  id: Type.String({ pattern: '^C[1-9][0-9]{0,2}$' }),
  scope: bounded(4096), topic: bounded(120), summary: bounded(500),
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
  relations: { kind: 'conflicts-with' | 'supports' | 'depends-on'; target: string; owners: KnowledgeOwner[] }[];
  owners: KnowledgeOwner[];
}
export type KnowledgeContext = Pick<KnowledgeRecord, 'id' | 'scope' | 'topic' | 'summary' | 'claim' | 'kind' | 'provenance' | 'perspective' | 'validation' | 'validationNote'>;
export interface KnowledgeBridge { inspect(): Promise<KnowledgeRecord[]> }
