import { flowHandoffs, flowReferences, KNOWLEDGE_LIMITS, isConnection, type KnowledgeCandidate, type KnowledgeRecord, type OperationFlow } from '../shared/knowledge';

type SupportingClaim = Pick<KnowledgeRecord, 'id' | 'kind' | 'architecture' | 'flow' | 'scope' | 'provenance' | 'perspective'>;
function isBehaviorSupport(claim: SupportingClaim): boolean {
  return ['behavior', 'operation', 'responsibility'].includes(claim.kind) && !claim.architecture;
}
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
  validateFlowShape(flow);
  const services = flow.steps.map(step => {
    const service = resolve(step.service), claim = resolve(step.claim);
    if (service.kind !== 'entity' || !service.architecture || isConnection(service.architecture)) throw new Error('Flow step requires an explicit owning service or external/unresolved entity.');
    if (!isBehaviorSupport(claim)) throw new Error('Flow step requires a supporting behavior claim.');
    if (['service', 'interface'].includes(service.architecture.type) && claim.scope !== service.scope) throw new Error('Step evidence must belong to its owning service scope.');
    if (step.state === 'implementation' && (claim.provenance !== 'statically-inferred' || claim.perspective !== 'current' || ['external', 'unresolved'].includes(service.architecture.type))) throw new Error('Unavailable or declared behavior cannot be labeled implementation.');
    if (step.state === 'documented' && claim.provenance !== 'declared') throw new Error('Documented steps require declared support.');
    return service;
  });
  const connections = flowHandoffs(flow);
  const handoffs = flow.handoffs.map((handoff, index) => {
    const { from, to } = connections[index];
    const claim = resolve(handoff.claim), a = claim.architecture;
    if (handoff.kind === 'synchronous' || handoff.kind === 'asynchronous') {
      const type = handoff.kind === 'synchronous' ? 'api-call' : 'event';
      if (claim.kind !== 'relationship' || !a || !isConnection(a) || a.type !== type || a.from !== services[from].id || a.to !== services[to].id) throw new Error('Handoffs require a concrete API call/event matching explicit service endpoints.');
    } else {
      if (!isBehaviorSupport(claim)) throw new Error('Unknown/internal handoffs require an evidenced supporting claim.');
      if (handoff.kind === 'within-service' && services[from].id !== services[to].id) throw new Error('Internal handoffs cannot cross services.');
    }
    return { ...handoff, claim: claim.id };
  });
  const resolved = { ...flow, steps: flow.steps.map((step, index) => ({ ...step, service: services[index].id, claim: resolve(step.claim).id })), handoffs };
  if (flowReferences(resolved).length >= KNOWLEDGE_LIMITS.results) throw new Error('Flow support exceeds the shared result claim bound.');
  return resolved;
}

/** Reject malformed topology before resolving support. Loops/retries are annotations, never back-edges. */
function validateFlowShape(flow: OperationFlow): void {
  const explicit = flow.handoffs.some(edge => edge.from !== undefined || edge.to !== undefined);
  if (explicit && flow.handoffs.some(edge => edge.from === undefined || edge.to === undefined)) throw new Error('Do not mix explicit and adjacent handoffs.');
  if (!explicit && flow.handoffs.length !== flow.steps.length - 1) throw new Error('Each adjacent pair of steps requires an explicit handoff or unknown boundary.');
  const edges = flowHandoffs(flow), pairs = new Set<string>();
  for (const edge of edges) {
    if (edge.from >= flow.steps.length || edge.to >= flow.steps.length || edge.from === edge.to) throw new Error('Invalid flow endpoints; annotate retries/loops instead of cycles.');
    const pair = `${edge.from}:${edge.to}`;
    if (pairs.has(pair)) throw new Error('Duplicate flow handoff endpoints.');
    pairs.add(pair);
  }
  const visiting = new Set<number>(), visited = new Set<number>();
  const visit = (index: number) => {
    if (visiting.has(index)) throw new Error('Cyclic flow; annotate retries/loops instead.');
    if (visited.has(index)) return;
    visiting.add(index);
    for (const edge of edges.filter(edge => edge.from === index)) visit(edge.to);
    visiting.delete(index); visited.add(index);
  };
  visit(0);
  if (visited.size !== flow.steps.length) throw new Error('Disconnected steps require an explicit unknown boundary from the entry.');
  for (const [index, step] of flow.steps.entries()) {
    const outgoing = edges.filter(edge => edge.from === index), incoming = edges.filter(edge => edge.to === index);
    if (outgoing.length > 1 && step.kind !== 'branch' && step.kind !== 'parallel') throw new Error('Fan-out must explicitly identify conditional alternatives or parallel work.');
    if (step.kind === 'branch' && (outgoing.length < 2 || outgoing.some(edge => !edge.condition) || new Set(outgoing.map(edge => edge.condition)).size !== outgoing.length)) throw new Error('Branches require distinct condition labels on all alternatives.');
    if (step.kind === 'parallel' && (outgoing.length < 2 || outgoing.some(edge => edge.condition))) throw new Error('Parallel work requires explicit unconditional fan-out support.');
    if (step.kind === 'join' && incoming.length < 2) throw new Error('A join requires multiple explicit incoming handoffs.');
    if (incoming.length > 1 && step.kind !== 'join') throw new Error('Convergence must explicitly describe a supported or unresolved join.');
    if (['retry', 'loop'].includes(step.kind ?? '') && !step.annotation) throw new Error('Retries/loops require a bounded explanatory annotation.');
  }
}
