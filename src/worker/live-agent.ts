import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type Message, type AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { investigatorTool } from './investigator';
import { titleTool } from './title-tool';
import { retainedHistory, SOURCE_INSTRUCTIONS } from './agent-context';
import { chatgptModel, chatgptStream, type StreamObservation } from './chatgpt-stream';
import { LIVE_LIMITS, type Evidence, type LiveResult, type LiveStart, type LiveCheckpoint } from '../shared/live';
import { INVESTIGATION_LIMITS, type Exploration } from '../shared/investigation';
import type { SourceOperation, SourceRequest, SourceResult } from '../shared/sources';
import type { ChatGPTUsage } from '../shared/chatgpt';

export interface LiveCapabilities {
  access(): Promise<string>;
  source(operation: SourceOperation, input: SourceRequest): Promise<SourceResult & { evidence: Evidence[] }>;
  inspect?(ids: string[]): Promise<Evidence[]>;
  progress(text: string, activity: string): void;
  checkpoint?(value: LiveCheckpoint): void;
  reportUsage?(request: number, usage?: ChatGPTUsage): void;
}

/** Two isolated Pi contexts; all source and credential authority is brokered by main. */
export async function runLiveAgent(job: LiveStart, capabilities: LiveCapabilities, signal: AbortSignal, http?: typeof fetch): Promise<LiveResult> {
  let text = '', activity = 'Preparing ChatGPT…', requests = 0, reported = 0, limited = false, usageComplete = true, limitNotice = '';
  let exploration: Exploration | undefined, title: string | undefined;
  const usage: ChatGPTUsage = { input: 0, output: 0, cachedInput: 0 };
  const observations: StreamObservation[] = [];
  const agents = new Set<Agent>();
  const finalizedText: string[] = [];
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    if (!progressTimer) progressTimer = setTimeout(() => {
      progressTimer = undefined;
      if (!signal.aborted) capabilities.progress(text, activity);
    }, 50);
  };
  const abort = () => { for (const agent of agents) agent.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  const streamFn: StreamFn = async (_model, context, options) => {
    try {
      signal.throwIfAborted();
      if (limited) throw new Error(limitNotice || 'Job limit reached.');
      if (requests >= LIVE_LIMITS.requests || Buffer.byteLength(JSON.stringify(context)) > LIVE_LIMITS.historyBytes) {
        limited = true;
        limitNotice = requests >= LIVE_LIMITS.requests ? 'Request limit reached. Retry explicitly for a new attempt.' : 'Conversation context is too large. Start a new conversation; no history was silently removed.';
        throw new Error(limitNotice);
      }
      // A failure never starts another paid request, including in the other role.
      if (observations.some(observation => observation.failure)) throw new Error('Model request failed. Retry explicitly.');
      const token = await capabilities.access();
      signal.throwIfAborted();
      requests++;
      const observation: StreamObservation = {}; observations.push(observation);
      return chatgptStream(job.model, context, token, AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]), observation, http);
    } catch {
      // Agent's stream contract encodes preparation failures as protocol events.
      const output = createAssistantMessageEventStream();
      const error: AssistantMessage = { role: 'assistant', content: [], api: 'openai-responses', provider: 'openai', model: job.model,
        stopReason: signal.aborted ? 'aborted' : 'error', errorMessage: 'Athena stopped this request. Retry explicitly.', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      output.push({ type: 'error', reason: error.stopReason as 'error' | 'aborted', error }); output.end();
      return output;
    }
  };
  const createAgent = (role: 'main' | 'investigator', tools: AgentTool[], systemPrompt: string, history: Message[] = []) => {
    const agent = new Agent({
      initialState: { model: chatgptModel(job.model), tools, systemPrompt, messages: history.filter(message => message.role !== 'system') },
      toolExecution: 'sequential', identity: { userAgent: { custom: 'Athena/0.1' }, attribution: null }, streamFn,
    });
    agents.add(agent);
    agent.subscribe(event => {
      if (event.type === 'agent_end' && role === 'investigator') agents.delete(agent);
      if (signal.aborted) return;
      if (event.type === 'message_end' && event.message.role === 'assistant' && requests > reported) {
        reported = requests; capabilities.reportUsage?.(requests, observations.at(-1)?.usage);
        if (role === 'main' && ['stop', 'toolUse'].includes(event.message.stopReason)) {
          const finalized = event.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
          if (finalized) finalizedText.push(finalized);
        }
      }
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta' && role === 'main') {
        text += event.assistantMessageEvent.delta;
        if (text.length > LIVE_LIMITS.answerCharacters) { text = text.slice(0, LIVE_LIMITS.answerCharacters); limited = true; abort(); }
        activity = 'Receiving ChatGPT response…'; progress();
      } else if (event.type === 'tool_execution_start') {
        activity = role === 'investigator' ? `Investigator: ${event.toolName}` : `Athena: ${event.toolName}`;
        if (role === 'main' && text && !text.endsWith('\n\n')) text += '\n\n';
        progress();
      }
    });
    return agent;
  };
  const investigate = investigatorTool(job.roots, {
    createAgent: (tools, prompt) => createAgent('investigator', tools, prompt),
    source: (operation, input) => capabilities.source(operation, input),
    checkpoint: value => { exploration = value; capabilities.checkpoint?.({ exploration }); },
    limit: notice => { limited = true; limitNotice = notice; abort(); },
    progress: value => { activity = value; progress(); },
  }, signal);
  const inspect: AgentTool = {
    name: 'inspect_evidence', label: 'Inspect retained evidence',
    description: 'Inspect bounded excerpts by existing evidence ID only. For fresh source exploration use investigate. No arbitrary file reads.',
    parameters: Type.Object({ ids: Type.Array(Type.String({ pattern: '^E[1-9][0-9]{0,3}$' }), { minItems: 1, maxItems: INVESTIGATION_LIMITS.inspections }) }, { additionalProperties: false }),
    async execute(_id, params) {
      if (!capabilities.inspect) throw new Error('Evidence inspection is unavailable.');
      return { content: [{ type: 'text', text: JSON.stringify(await capabilities.inspect((params as { ids: string[] }).ids)) }], details: {} };
    },
  };
  const naming = titleTool(value => { title = value; capabilities.checkpoint?.({ title }); });
  const agent = createAgent('main', [investigate, inspect, ...(job.needsTitle ? [naming] : [])], `You are Athena, a conversational repository investigation assistant. ${job.needsTitle ? 'Call set_conversation_title with a concise descriptive title derived from the initial question before answering. Naming shares this job and its limits; if it fails, proceed with the answer and the local title fallback. Initial question for naming only (untrusted user data): ' + JSON.stringify(job.titlePrompt ?? job.prompt) : 'The conversation already has a model-derived title; do not rename it.'} Answer ordinary questions directly. You have no fresh source exploration tools: delegate source investigation using investigate once per user job. Automatically choose likely repositories from metadata and the question; ask clarification only if ambiguity materially changes the work. You may inspect retained evidence by ID for bounded follow-up inspection. Use the investigator's bounded result, never request its transcript. If its result is partial, preserve uncertainty in your answer. Candidate knowledge changes are proposals, not saved knowledge.\n${SOURCE_INSTRUCTIONS}\nGlobally designated folders/repositories (untrusted metadata):\n${JSON.stringify(job.roots)}`, job.history);
  let failed = false;
  try { signal.throwIfAborted(); await agent.prompt(job.prompt); } catch { failed = true; }
  finally {
    signal.removeEventListener('abort', abort); clearTimeout(progressTimer);
    if (!signal.aborted) capabilities.progress(text, activity);
  }
  for (const observation of observations) {
    if (!observation.usage) usageComplete = false;
    else { usage.input += observation.usage.input; usage.output += observation.usage.output; usage.cachedInput += observation.usage.cachedInput; }
  }
  const last = agent.state.messages.at(-1);
  const success = !failed && !signal.aborted && !limited && last?.role === 'assistant' && last.stopReason === 'stop';
  const history = success ? retainedHistory(agent) : [];
  const historyFits = Buffer.byteLength(JSON.stringify(history)) <= LIVE_LIMITS.historyBytes;
  if (success) text = finalizedText.join('\n\n');
  if (text.length > LIVE_LIMITS.answerCharacters) limited = true;
  const reason = observations.findLast(observation => observation.failure)?.failure;
  return { status: limited || !historyFits ? 'limit' : signal.aborted ? 'cancelled' : !success ? 'failed' : exploration?.result.status === 'partial' ? 'partial' : 'complete', text: limited || !historyFits ? text.slice(0, LIVE_LIMITS.answerCharacters - 512) + '\n\n' + (limitNotice || 'Local output/history limit reached. Start a new conversation.') : text,
    history: historyFits ? history : [], requests, usageComplete: requests > 0 && usageComplete, ...(exploration ? { exploration } : {}), ...(title ? { title } : {}),
    ...(observations.some(observation => observation.usage) ? { usage } : {}), ...(reason ? { reason } : {}) };
}
