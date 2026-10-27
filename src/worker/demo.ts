import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_MESSAGE_LENGTH, type DemoJob } from '../shared/contracts';

// This model descriptor has no usable endpoint. The only stream function is local.
const model: Model<'openai-completions'> = {
  id: 'athena-local-demo', name: 'Local demonstration', api: 'openai-completions',
  provider: 'athena-demo', baseUrl: '', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16_000, maxTokens: 1_000,
};
const parent = process.parentPort;
if (!parent) throw new Error('The demonstration requires an Electron utility process.');
let started = false;
parent.on('message', async ({ data }: { data: DemoJob }) => {
  if (started) return;
  started = true;
  try {
    if (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > MAX_MESSAGE_LENGTH) throw new Error('Invalid job');
    parent.postMessage({ type: 'progress', text: 'Preparing a local demonstration…' });
    const answer = `Local demonstration complete.\n\nYou asked: ${data.text}\n\nYour conversation is saved on this Mac. No repositories were read, no model was contacted, and no paid work was performed.`;
    const agent = new Agent({
      initialState: { model, tools: [], systemPrompt: 'Return the deterministic local demonstration.' },
      getApiKey: () => undefined,
      streamFn: async () => {
        await delay(600);
        parent.postMessage({ type: 'progress', text: 'Preparing the demonstration response. No model calls…' });
        await delay(600);
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: 'assistant', content: [{ type: 'text', text: answer }],
          api: model.api, provider: model.provider, model: model.id,
          stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: 'done', reason: 'stop', message });
        return stream;
      },
    });
    await agent.prompt(data.text);
    const result = agent.state.messages.at(-1);
    if (result?.role !== 'assistant' || result.stopReason !== 'stop') throw new Error('Failed job');
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('');
    parent.postMessage({ type: 'result', text });
  } catch {
    parent.postMessage({ type: 'failure' });
  }
});
