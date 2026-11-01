import { isConnection, type KnowledgeCandidate, type KnowledgeRecord, type OperationFlow } from '../shared/knowledge';

type SupportingClaim = Pick<KnowledgeRecord, 'id' | 'kind' | 'architecture' | 'flow' | 'scope' | 'provenance' | 'perspective'>;
/** Resolve only explicit claims inside the central publisher; never guess a service from its name. */
export function resolveOperationFlow(candidate: KnowledgeCandidate, find: (id: string) => SupportingClaim | undefined): OperationFlow | undefined {
  if (!candidate.flow) return;
  if (candidate.kind !== 'operation' || candidate.architecture) throw new Error('Only operation claims can retain a flow.');
  const resolve = (ref: string) => {
    const record = find(ref);
    if (!record || record.flow) throw new Error('Flow requires explicit non-flow supporting claims.');
    return record;
  };
  const flow = candidate.flow;
  if (flow.handoffs.length !== flow.steps.length - 1) throw new Error('Each adjacent pair of steps requires an explicit handoff or unknown boundary.');
  const services = flow.steps.map(step => {
    const service = resolve(step.service), claim = resolve(step.claim);
    if (service.kind !== 'entity' || !service.architecture || isConnection(service.architecture)) throw new Error('Flow step requires an explicit owning service or external/unresolved entity.');
    if (!['behavior', 'operation', 'responsibility'].includes(claim.kind) || claim.architecture) throw new Error('Flow step requires a supporting behavior claim.');
    if (['service', 'interface'].includes(service.architecture.type) && claim.scope !== service.scope) throw new Error('Step evidence must belong to its owning service scope.');
    if (step.state === 'implementation' && (claim.provenance !== 'statically-inferred' || claim.perspective !== 'current' || ['external', 'unresolved'].includes(service.architecture.type))) throw new Error('Unavailable or declared behavior cannot be labeled implementation.');
    if (step.state === 'documented' && claim.provenance !== 'declared') throw new Error('Documented steps require declared support.');
    return service;
  });
  const handoffs = flow.handoffs.map((handoff, index) => {
    const claim = resolve(handoff.claim), a = claim.architecture;
    if (handoff.kind === 'synchronous') {
      if (claim.kind !== 'relationship' || !a || !isConnection(a) || a.type !== 'api-call' || a.from !== services[index].id || a.to !== services[index + 1].id) throw new Error('Synchronous handoffs require a concrete API call matching adjacent service endpoints.');
    } else {
      if (!['behavior', 'operation', 'responsibility'].includes(claim.kind) || a) throw new Error('Unknown/internal handoffs require an evidenced supporting claim.');
      if (handoff.kind === 'within-service' && services[index].id !== services[index + 1].id) throw new Error('Internal handoffs cannot cross services.');
    }
    return { ...handoff, claim: claim.id };
  });
  return { ...flow, steps: flow.steps.map((step, index) => ({ ...step, service: services[index].id, claim: resolve(step.claim).id })), handoffs };
}
