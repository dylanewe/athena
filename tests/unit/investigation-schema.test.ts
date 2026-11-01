import { expect, test } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import { runLiveAgent } from '../../src/worker/live-agent';

test.each(['openai-completions', 'openai-responses', 'anthropic-messages'] as const)('%s receives an object-root delegation schema with bounded question and scope fields', async api => {
  const model: Model<Api> = { api, id: 'fixture', name: 'Fixture', provider: 'fake', baseUrl: 'https://fake.example/v1', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 4096, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } };
  const pinned = { model, authHeader: true, headerRefs: {} };
  let body: { tools: { name?: string; input_schema?: unknown; function?: { name: string; parameters: unknown }; parameters?: unknown }[] } | undefined;
  await runLiveAgent({ apiKey: { conversation: pinned, investigator: pinned }, model: model.id, prompt: 'Compare repositories', history: [], roots: [] }, {
    access: async () => { throw new Error('No OAuth'); },
    apiAccess: async () => ({ token: 'fake-schema-key', headers: {} }),
    source: async () => { throw new Error('No sources requested'); },
    progress() {},
  }, new AbortController().signal, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response('{}', { status: 401 });
  });
  const tool = body?.tools.find(tool => (tool.function?.name ?? tool.name) === 'investigate');
  const schema = (api === 'anthropic-messages' ? tool?.input_schema : tool?.function?.parameters ?? tool?.parameters) as Record<string, unknown>;
  expect(schema).toMatchObject({ type: 'object', properties: {
    question: { type: 'string', minLength: 1, maxLength: 8000 },
    tasks: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { question: { maxLength: 8000 }, scope: { maxLength: 512 } } } },
  } });
  expect(schema).not.toHaveProperty('anyOf');
});
