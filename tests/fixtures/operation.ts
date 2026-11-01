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
export const branchingCandidates: KnowledgeCandidate[] = structuredClone(operationCandidates);
branchingCandidates[3].topic = 'Validate checkout';
branchingCandidates[4].claim = 'Charge retries after a temporary failure, then publishes each item.';
branchingCandidates[7].architecture = { type: 'event', from: 'C2', to: 'C3', mechanism: 'payment.requested' };
branchingCandidates.push(
  claim('C10', 'Reject invalid checkout'),
  { ...claim('C11', 'Publish each payment item', 'ledger', 'E2'), claim: 'Iterate payment items without expanding every iteration.' },
);
branchingCandidates[8].flow = {
  steps: [
    { name: 'Checkout valid?', service: 'C1', claim: 'C4', state: 'implementation', kind: 'branch' },
    { name: 'Charge with retry', service: 'C2', claim: 'C5', state: 'implementation', kind: 'retry', annotation: 'At most 3 attempts after temporary failure; final failure throws. Not an application/model retry.' },
    { name: 'Consumer unavailable', service: 'C3', claim: 'C6', state: 'unknown', omissions: ['Consumer implementation is unavailable; delivery and completion are not established.'] },
    { name: 'Reject invalid checkout', service: 'C1', claim: 'C10', state: 'implementation' },
    { name: 'Publish payment items', service: 'C2', claim: 'C11', state: 'implementation', kind: 'loop', annotation: 'One publication per item; item count is input-dependent. Iterations are not expanded.' },
  ],
  handoffs: [
    { from: 0, to: 1, kind: 'synchronous', claim: 'C7', condition: 'Valid checkout / success' },
    { from: 0, to: 3, kind: 'within-service', claim: 'C10', condition: 'Invalid checkout / failure' },
    { from: 1, to: 4, kind: 'within-service', claim: 'C11' },
    { from: 4, to: 2, kind: 'asynchronous', claim: 'C8', omissions: ['Consumer subscription and delivery guarantees were not inspected.'] },
  ],
  omissions: ['Final retry exhaustion is annotated, not expanded. No consumer completion or ordering between alternative paths is claimed.'],
};
export const branchingFiles = [
  ['shop', 'checkout.ts', 'export function checkout(valid) { if (!valid) return { error: "Invalid checkout" }; return ledger.charge(); }\n'],
  ['ledger', 'charge.ts', 'export async function charge(items) { for (let attempt=0; attempt<3; attempt++) { try { await chargeOnce(); break; } catch (error) { if (attempt===2) throw error; } } for (const item of items) events.publish("payment.requested", item); }\n'],
  ['ledger', 'notes.md', 'Payment requests are sent to the bank consumer. Consumer implementation, subscription and delivery guarantees are unavailable.\n'],
] as const;

export const parallelCandidates: KnowledgeCandidate[] = structuredClone(operationCandidates);
parallelCandidates.push(claim('C10', 'Validate item'), claim('C11', 'Await charge and validation'));
parallelCandidates[8].flow = {
  steps: [
    { name: 'Dispatch tasks', service: 'C1', claim: 'C4', state: 'implementation', kind: 'parallel' },
    { name: 'Charge', service: 'C2', claim: 'C5', state: 'implementation' },
    { name: 'Validate item', service: 'C1', claim: 'C10', state: 'implementation' },
    { name: 'Await charge and validation', service: 'C1', claim: 'C11', state: 'implementation', kind: 'join', annotation: 'Promise.all waits for charge and local validation, not downstream bank processing.' },
  ],
  handoffs: [
    { from: 0, to: 1, kind: 'synchronous', claim: 'C7' },
    { from: 0, to: 2, kind: 'within-service', claim: 'C4' },
    { from: 1, to: 3, kind: 'unknown', claim: 'C11', omissions: ['Ledger failure propagation was not inspected.'] },
    { from: 2, to: 3, kind: 'within-service', claim: 'C11' },
  ],
  omissions: ['Bank internals and ledger failure propagation were not inspected. No downstream consumer join is claimed.'],
};
export const parallelFiles = [
  ['shop', 'checkout.ts', 'export async function checkout() { await Promise.all([ledger.charge(), validateItem()]); return "submitted"; }\n'],
  ['ledger', 'charge.ts', 'export function charge() { return bank.authorize(); }\n'],
  ['ledger', 'notes.md', 'Bank processing details are unavailable.\n'],
] as const;

export const operationFiles = [
  ['shop', 'checkout.ts', 'export function checkout() { return ledger.charge(); }\n'],
  ['ledger', 'charge.ts', 'export function charge() { return bank.authorize(); }\n'],
  ['ledger', 'notes.md', 'The bank authorizes payment. Its implementation is unavailable.\n'],
] as const;
