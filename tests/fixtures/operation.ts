import type { KnowledgeCandidate } from '../../src/shared/knowledge';

const claim = (id: string, topic: string, scope = 'shop', evidenceId = 'E1'): KnowledgeCandidate => ({ id, scope, topic, summary: topic, kind: 'behavior', claim: topic, provenance: 'statically-inferred', perspective: 'current', evidenceIds: [evidenceId], relations: [] });
/** Checkout -> ledger -> unavailable bank, extracted from ordinary code/docs, with no flow manifest. */
export const operationCandidates: KnowledgeCandidate[] = [
  { ...claim('C1', 'Shop'), kind: 'entity', architecture: { type: 'service' } },
  { ...claim('C2', 'Ledger', 'ledger', 'E2'), kind: 'entity', architecture: { type: 'service' } },
  { ...claim('C3', 'Bank', 'ledger', 'E3'), kind: 'entity', provenance: 'declared', architecture: { type: 'external', resource: 'api' } },
  claim('C4', 'Accept checkout'), claim('C5', 'Charge account', 'ledger', 'E2'),
  { ...claim('C6', 'Bank internals unavailable', 'ledger', 'E3'), provenance: 'declared' },
  { ...claim('C7', 'Call charge'), kind: 'relationship', architecture: { type: 'api-call', from: 'C1', to: 'C2', mechanism: 'ledger.charge()' } },
  { ...claim('C8', 'Call authorize', 'ledger', 'E2'), kind: 'relationship', architecture: { type: 'api-call', from: 'C2', to: 'C3', mechanism: 'bank.authorize()' } },
  { ...claim('C9', 'Checkout operation'), kind: 'operation', flow: {
    steps: [{ name: 'Accept checkout', service: 'C1', claim: 'C4', state: 'implementation' }, { name: 'Charge account', service: 'C2', claim: 'C5', state: 'implementation' }, { name: 'Bank boundary', service: 'C3', claim: 'C6', state: 'unknown' }],
    handoffs: [{ kind: 'synchronous', claim: 'C7' }, { kind: 'synchronous', claim: 'C8' }],
    omissions: ['Bank implementation unavailable; retries, failures and alternate branches not investigated.'],
  } },
];
export const operationFiles = [
  ['shop', 'checkout.ts', 'export function checkout() { return ledger.charge(); }\n'],
  ['ledger', 'charge.ts', 'export function charge() { return bank.authorize(); }\n'],
  ['ledger', 'notes.md', 'The bank authorizes payment. Its implementation is unavailable.\n'],
] as const;
