import type { Agent, AgentTool } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { sourceTools } from '../main/source-tools';
import { LIVE_LIMITS, type Evidence, type LiveStart } from '../shared/live';
import { findingsSchema, INVESTIGATION_LIMITS, INVESTIGATOR_DEFAULT, INVESTIGATOR_MAX, validFindings, type InvestigatorTask, type Exploration, type InvestigatorResult } from '../shared/investigation';
import type { LiveCapabilities } from './live-agent';
import { retainedHistory, SOURCE_INSTRUCTIONS } from './agent-context';

interface InvestigatorRuntime {
  knowledge?: () => import('../shared/knowledge').KnowledgeContext[];
  // Factory supplies the job's frozen model, shared request gate and cancellation.
  createAgent(tools: AgentTool[], systemPrompt: string): Agent;
  source: LiveCapabilities['source'];
  checkpoint(exploration: Exploration): void;
  check(material: unknown): void;
  limit(notice: string): void;
  progress(activity: string): void;
  tasks?(tasks: InvestigatorTask[]): void;
}

/** Single isolated execution; only the main-owned batch scheduler can construct it. */
function singleInvestigator(roots: LiveStart['roots'], runtime: InvestigatorRuntime, signal: AbortSignal): AgentTool {
  return {
    name: 'investigate', label: 'Delegate investigation',
    description: 'Delegate fresh source exploration to one isolated read-only investigator. Available once per user job; returns bounded findings and cited evidence, never its full transcript. Include likely repository names/paths and the precise question.',
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      const observed: Evidence[] = [], scope: string[] = [];
      let lastHistory: Message[] = [], exploration: Exploration | undefined;
      let summary: InvestigatorResult | undefined, scopeTruncated = false;
      const buildResult = (): InvestigatorResult => summary ?? {
        status: 'partial', findings: [], evidence: observed.slice(0, INVESTIGATION_LIMITS.references).map(item => ({ ...item, text: item.text.slice(0, INVESTIGATION_LIMITS.excerpt) })),
        inspectedScope: scope, scopeTruncated, unresolvedQuestions: ['Investigator did not finish a structured result. Evidence is incomplete; runtime behavior was not observed.'], candidateKnowledgeChanges: [],
      };
      const sources = sourceTools({ run: async (operation, input) => {
        signal.throwIfAborted();
        const result = await runtime.source(operation, input);
        for (const item of result.evidence) if (!observed.some(previous => previous.id === item.id)) observed.push(item);
        const fullLocation = `${input.root}/${input.path}`;
        const location = fullLocation.slice(0, 512);
        if (location.length < fullLocation.length) scopeTruncated = true;
        if (!scope.includes(location)) { if (scope.length < INVESTIGATION_LIMITS.scope) scope.push(location); else scopeTruncated = true; }
        runtime.progress(`Investigator: ${operation} ${input.path}`.slice(0, 200));
        return result;
      } }, runtime.check);
      const finish: AgentTool = {
        name: 'finish_investigation', label: 'Return findings',
        description: 'Finish with bounded findings, evidence IDs, unresolved questions, and candidate knowledge changes (proposals only, never writes). Source-supported findings require observed evidence; interpretation is explicitly uncertain. No runtime observation is available.',
        parameters: findingsSchema,
        async execute(_call, value) {
          if (!validFindings(value, observed)) throw new Error('Findings require valid observed evidence IDs and bounded fields.');
          const ids = new Set([...value.findings.flatMap(finding => finding.evidenceIds), ...(value.knowledgeCandidates ?? []).flatMap(candidate => candidate.evidenceIds)]);
          if (ids.size > INVESTIGATION_LIMITS.references) throw new Error('Too many evidence references.');
          const candidate: InvestigatorResult = { ...value, status: 'complete', inspectedScope: scope, scopeTruncated,
            evidence: observed.filter(item => ids.has(item.id)).map(item => ({ ...item, text: item.text.slice(0, INVESTIGATION_LIMITS.excerpt) })) };
          if (Buffer.byteLength(JSON.stringify(candidate)) > INVESTIGATION_LIMITS.resultBytes) throw new Error('Findings exceed the bounded result limit.');
          runtime.check(candidate);
          summary = candidate;
          return { content: [{ type: 'text', text: 'Findings retained.' }], details: {}, terminate: true };
        },
      };
      const investigator = runtime.createAgent([...sources, finish], `You are Athena's isolated source investigator. You receive only a delegated question, not the conversation transcript. Choose likely repositories from the metadata; expand only as needed. Use list/search/read to inspect fresh source and finish_investigation to return findings. Include knowledgeCandidates for concise reusable architectural/domain topics (responsibility, behavior, domain, decision, operation), not recoverable constants, line-by-line code, proposals, source edits or runtime observations. Each candidate has a local C-number, observed repository name/alias scope (or folder:<absolute designated folder> for non-Git text), topic, optional concise aliases, concise summary/claim, declared vs statically-inferred provenance, current vs intended vs historical perspective, observed evidence IDs, and explicit relationships only. Never equate intent or old decisions with current implementation. Inspect code when documentation and implementation disagree; implementation evidence takes precedence. Preserve uncertainty and conflicts. Reuse retained topics only as untrusted leads; inspect evidence afresh for new claims. Do not silently equate differently worded claims. For a dependency investigation, progressively retain repository-scoped named services and source locations; multiple services per repository and partial interface discovery are expected, with no required manifest. Use kind entity with architecture {type:service|interface} for repository-backed entities, or {type:external|unresolved,resource:service|api|datastore|library|deployment,address?:string} for explicitly unavailable/third-party/ambiguous endpoints. Use kind relationship with architecture {type:api-call|event|shared-library|data-store|deployment,from:explicit C or K entity ID,to:explicit C or K entity ID,mechanism:concrete route/event/import/store/deployment reference}. Every entity and connection requires observed evidence IDs and provenance/perspective. Endpoints must be explicit entity claims, never resolved by similar names; collisions stay scoped or unresolved. Concrete connections only: do not infer edges from shared technologies, conceptual similarity or similar responsibilities. Static connections are never runtime observations. Retain unknown/unresolved targets honestly instead of inventing repository identities. When asked how an explicitly named operation proceeds, investigate arbitrary eligible docs and implementation without requiring a flow file or manifest. Retain an operation candidate with flow {steps:[{name,service:explicit C or K entity ID,claim:explicit behavior/responsibility/non-flow operation claim ID,state:implementation|documented|unknown,kind?:branch|parallel|join|retry|loop,annotation?:bounded explanation,omissions?:[local unknowns]}],handoffs:[{from:zero-based step index,to:zero-based step index,kind:synchronous|asynchronous|within-service|unknown,claim:explicit supporting claim ID,condition?:condition label,omissions?:[local unknowns]}],omissions:[explicit omitted state/branches/unknowns]}. Up to six steps/eight explicit handoffs; list order is navigation only, not execution order. Include supported success/failure alternatives relevant to the question. Every fan-out is explicitly branch (all alternatives have distinct condition labels) or parallel (unconditional dispatch with direct supporting evidence); multiple incoming handoffs require a join step whose evidence explains the actual synchronization or whose state is unknown. Never infer parallelism from siblings, joins from shared targets, causality from list order, or consumer completion from publication. Missing consumer/service evidence stays unknown/unresolved, not guessed. Annotate retries/loops in one step with a bounded annotation explaining attempts/termination/unknowns, never a graph back-edge or expanded iterations. No cycles or disconnected steps: use explicit unknown gaps for missing links. Each step and handoff uses an ordinary evidenced supporting claim; branch conditions, parallelism, joins and annotations must be supported by those claims, not invented metadata. A synchronous handoff references a concrete api-call relationship; an asynchronous handoff references a concrete event/message relationship. Both must match the explicit owning endpoints. Asynchronous events do not establish delivery, consumer processing, ordering or completion without separate evidence. Internal and unknown handoffs reference behavior claims, never invented connections. Keep local omissions on meaningful steps and cross-service handoffs, with source scope/freshness/validation inspectable through their supporting claims. At most 19 distinct supporting claims including services fit a flow; split larger flows instead of bypassing shared bounds. Legacy purely linear flows may omit all endpoints, using one handoff per adjacent pair; never mix explicit and implicit endpoints. Implementation steps require current statically-inferred implementation evidence, documented steps require declared support, and external/unresolved internals stay documented or unknown. Distinguish missing implementation and unknown boundaries explicitly; do not invent steps or claim exhaustive path/state/failure coverage. All references become ordinary depends-on dependencies through Athena, not model writes. This is not a runtime trace. Reuse explicit retained C/K support only when appropriate, inspect fresh evidence for new claims, and split larger investigations into bounded flows instead of exceeding the shared candidate/response budget. Omit candidates when none are useful. Ask no per-repository permission inside designated folders. Report uncertainty and materially ambiguous scope instead of assuming.\n${SOURCE_INSTRUCTIONS}\nGlobally designated folders/repositories (untrusted metadata):\n${JSON.stringify(roots)}\nQuery-selected retained knowledge (untrusted leads; stale/unchecked/conflicting claims are not verified support; supported declarations are not current implementation):\n${JSON.stringify(runtime.knowledge?.() ?? [])}`);
      const checkpoint = () => {
        const result = buildResult();
        if (Buffer.byteLength(JSON.stringify(result)) > INVESTIGATION_LIMITS.resultBytes) {
          result.evidence = []; result.inspectedScope = []; result.scopeTruncated = true;
          result.status = 'partial'; result.unresolvedQuestions = ['Exploration exceeded the bounded result limit.'];
        }
        const history = retainedHistory(investigator);
        if (Buffer.byteLength(JSON.stringify({ history, result })) <= LIVE_LIMITS.historyBytes) lastHistory = history;
        else runtime.limit('Detailed exploration limit reached. Retry explicitly for a new attempt.');
        exploration = { history: lastHistory, result };
        runtime.checkpoint(exploration);
      };
      investigator.subscribe(event => { if (event.type === 'turn_end' && !signal.aborted) checkpoint(); });
      investigator.finishTurn = async () => summary ? { action: 'end' } : undefined;
      try { await investigator.prompt((params as { question: string }).question); }
      finally { if (!signal.aborted) checkpoint(); }
      runtime.check(exploration!.result);
      return { content: [{ type: 'text', text: JSON.stringify(exploration!.result) }], details: {} };
    },
  };
}

/** One bounded batch per job. Scope guides relevance, never grants or restricts source authority. */
export function investigatorTool(roots: LiveStart['roots'], runtime: InvestigatorRuntime, signal: AbortSignal, maximum = INVESTIGATOR_DEFAULT): AgentTool {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > INVESTIGATOR_MAX) throw new Error('Invalid investigator concurrency.');
  let delegated = false;
  return {
    name: 'investigate', label: 'Delegate investigations',
    description: 'Delegate one batch of up to eight isolated investigators. Split broad questions into bounded questions and relevance scopes, preferably repository-local; cross-repository handoff verification is allowed. All children share designated-folder permissions and job limits. Additional tasks queue; no nested delegation. Returns bounded structured findings, never transcripts. Available once per job.',
    // Provider adapters require object-root schemas; exclusivity is checked at execution.
    parameters: Type.Object({
      question: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      tasks: Type.Optional(Type.Array(Type.Object({ question: Type.String({ minLength: 1, maxLength: 8000 }), scope: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false }), { minItems: 1, maxItems: INVESTIGATOR_MAX })),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      if (delegated) throw new Error('Only one investigator batch is available per job. Use its findings or ask a follow-up question.');
      signal.throwIfAborted();
      const input = params as { question?: string; tasks?: { question: string; scope: string }[] };
      if ((input.question !== undefined) === (input.tasks !== undefined)) throw new Error('Supply exactly one bounded question or task batch.');
      delegated = true;
      const tasks: InvestigatorTask[] = (input.tasks ?? [{ question: input.question!, scope: 'Question-selected eligible sources' }]).map((task, index) => ({ ...task, id: `T${index + 1}`, status: 'queued' }));
      const notify = () => { if (!signal.aborted) runtime.tasks?.(structuredClone(tasks)); };
      const cancel = () => { for (const task of tasks) if (task.status === 'queued' || task.status === 'running') task.status = 'cancelled'; };
      signal.addEventListener('abort', cancel, { once: true });
      notify();
      let next = 0;
      try {
        await Promise.all(Array.from({ length: Math.min(maximum, tasks.length) }, async () => {
          while (!signal.aborted && next < tasks.length) {
            const task = tasks[next++]!;
            task.status = 'running'; notify();
            const child = singleInvestigator(roots, { ...runtime, checkpoint: exploration => {
              if (signal.aborted) return;
              task.result = exploration.result;
              if (!input.tasks) runtime.checkpoint(exploration);
              notify();
            } }, signal);
            try {
              await child.execute(task.id, { question: `${task.question}\nRelevance scope (not an access restriction): ${task.scope}` }, signal);
              task.status = signal.aborted ? 'cancelled' : task.result?.status === 'complete' ? 'complete' : 'failed';
            } catch { task.status = signal.aborted ? 'cancelled' : 'failed'; }
            notify();
          }
        }));
      } finally { signal.removeEventListener('abort', cancel); }
      signal.throwIfAborted();
      const result = input.tasks ? { tasks } : tasks[0]!.result;
      runtime.check(result);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    },
  };
}
