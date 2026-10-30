import { Type, type Static } from 'typebox';
import { Check } from 'typebox/value';
import type { Message } from '@earendil-works/pi-ai';
import type { Evidence } from './live';

export const INVESTIGATION_LIMITS = { resultBytes: 64 * 1024, references: 32, excerpt: 512, scope: 32, inspections: 8, inspectionCharacters: 4000 } as const;
const notes = Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 8 });
export const findingsSchema = Type.Object({
  findings: Type.Array(Type.Object({
    claim: Type.String({ minLength: 1, maxLength: 1000 }),
    support: Type.Union([Type.Literal('source'), Type.Literal('interpretation')]),
    evidenceIds: Type.Array(Type.String({ pattern: '^E[1-9][0-9]{0,3}$' }), { maxItems: 8 }),
  }, { additionalProperties: false }), { maxItems: 12 }),
  unresolvedQuestions: notes,
  candidateKnowledgeChanges: notes,
}, { additionalProperties: false });
export type Findings = Static<typeof findingsSchema>;
export interface InvestigatorResult extends Findings {
  status: 'complete' | 'partial';
  evidence: Evidence[];
  inspectedScope: string[];
  scopeTruncated: boolean;
}
/** Local detailed exploration, never replayed into the conversational context or renderer. */
export interface Exploration { history: Message[]; result: InvestigatorResult }
export function validFindings(value: unknown, evidence: Evidence[]): value is Findings {
  return Check(findingsSchema, value) && value.findings.every(finding =>
    (finding.support !== 'source' || finding.evidenceIds.length > 0) &&
    finding.evidenceIds.every(id => evidence.some(item => item.id === id)));
}
