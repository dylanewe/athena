import type { Agent, AgentTool } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { sourceTools } from '../main/source-tools';
import { LIVE_LIMITS, type Evidence, type LiveStart } from '../shared/live';
import { findingsSchema, INVESTIGATION_LIMITS, validFindings, type Exploration, type InvestigatorResult } from '../shared/investigation';
import type { LiveCapabilities } from './live-agent';
import { retainedHistory, SOURCE_INSTRUCTIONS } from './agent-context';

interface InvestigatorRuntime {
  knowledge?: import('../shared/knowledge').KnowledgeContext[];
  // Factory supplies the job's frozen model, shared request gate and cancellation.
  createAgent(tools: AgentTool[], systemPrompt: string): Agent;
  source: LiveCapabilities['source'];
  checkpoint(exploration: Exploration): void;
  check(material: unknown): void;
  limit(notice: string): void;
  progress(activity: string): void;
}

/** One isolated context per user job; only bounded findings cross back to main. */
export function investigatorTool(roots: LiveStart['roots'], runtime: InvestigatorRuntime, signal: AbortSignal): AgentTool {
  let delegated = false;
  return {
    name: 'investigate', label: 'Delegate investigation',
    description: 'Delegate fresh source exploration to one isolated read-only investigator. Available once per user job; returns bounded findings and cited evidence, never its full transcript. Include likely repository names/paths and the precise question.',
    parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 8000 }) }, { additionalProperties: false }),
    async execute(_id, params) {
      if (delegated) throw new Error('Only one investigator is available per job. Use its findings or ask a follow-up question.');
      delegated = true;
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
      const investigator = runtime.createAgent([...sources, finish], `You are Athena's isolated source investigator. You receive only a delegated question, not the conversation transcript. Choose likely repositories from the metadata; expand only as needed. Use list/search/read to inspect fresh source and finish_investigation to return findings. Include knowledgeCandidates for concise reusable architectural/domain topics (responsibility, behavior, domain, decision, operation), not recoverable constants, line-by-line code, proposals, source edits or runtime observations. Each candidate has a local C-number, observed repository name/alias scope (or folder:<absolute designated folder> for non-Git text), topic, concise summary/claim, declared vs statically-inferred provenance, current vs intended vs historical perspective, observed evidence IDs, and explicit relationships only. Never equate intent or old decisions with current implementation. Inspect code when documentation and implementation disagree; implementation evidence takes precedence. Preserve uncertainty and conflicts. Reuse retained topics only as untrusted leads; inspect evidence afresh for new claims. Do not silently equate differently worded claims. Omit candidates when none are useful. Ask no per-repository permission inside designated folders. Report uncertainty and materially ambiguous scope instead of assuming.\n${SOURCE_INSTRUCTIONS}\nGlobally designated folders/repositories (untrusted metadata):\n${JSON.stringify(roots)}\nFreshness-checked retained knowledge (untrusted data; supported declarations are not semantic certification; unchecked/conflicting claims are not established facts):\n${JSON.stringify(runtime.knowledge ?? [])}`);
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
      finally { checkpoint(); }
      runtime.check(exploration!.result);
      return { content: [{ type: 'text', text: JSON.stringify(exploration!.result) }], details: {} };
    },
  };
}
