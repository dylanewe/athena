import type { ElectronApplication } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Isolated fake saved registration; OAuth itself is exercised in chatgpt.spec.ts. */
export async function installLiveFixture(application: ElectronApplication, directory: string, root?: string, environment = false) {
  const fixture = join(directory, 'live-worker-fixture.mjs');
  writeFileSync(fixture, `
    const frame = value => 'data: ' + JSON.stringify(value) + '\\n\\n';
    const complete = frame({type:'response.completed', response:{status:'completed', usage:{input_tokens:10,output_tokens:4}}});
    globalThis.fetch = async (url, options) => {
      if (url !== 'https://api.openai.com/v1/responses' || options.redirect !== 'error') throw new Error('Wrong endpoint');
      const body = JSON.parse(options.body);
      if (body.store !== false || body.stream !== true || body.max_output_tokens || body.temperature) throw new Error('Wrong payload');
      if (new Headers(options.headers).get('authorization') !== 'Bearer desktop-live-oauth') throw new Error('Wrong authority');
      const hasTool = name => body.tools?.some(tool => tool.name === name);
      const called = name => body.input.some(item => item.type === 'function_call' && item.name === name);
      const call = (name, args) => {
        const item = {type:'function_call',id:'fc_1',call_id:'call_' + name,name,arguments:JSON.stringify(args)};
        return new Response(new TextEncoder().encode(frame({type:'response.output_item.added',output_index:0,item:{...item,arguments:''}}) + frame({type:'response.function_call_arguments.delta',output_index:0,delta:item.arguments}) + frame({type:'response.output_item.done',output_index:0,item}) + complete));
      };
      if (hasTool('set_conversation_title') && !called('set_conversation_title')) {
        const question = body.input.find(item => item.role === 'user');
        const title = 'Topic: ' + question.content.map(part => part.text ?? '').join('');
        return call('set_conversation_title', {title: title.slice(0, 100)});
      }
      if (${JSON.stringify(root ?? '')}) {
        if (hasTool('investigate') && !called('investigate')) return call('investigate', {question:'Find the exported answer'});
        if (hasTool('sources_read')) {
          if (!called('sources_read')) return call('sources_read', {root:${JSON.stringify(root ?? '')},path:${JSON.stringify(environment ? '.env' : 'answer.ts')},start:1,end:1});
          return call('finish_investigation', {findings:[{claim:${JSON.stringify(environment ? 'PASSWORD=synthetic-desktop-env-7' : 'The value is 42')},support:'source',evidenceIds:['E1']}],unresolvedQuestions:['Runtime behavior was not observed'],candidateKnowledgeChanges:['Constant location could be remembered']});
        }
      }
      const text = ${JSON.stringify(environment ? 'PASSWORD=synthetic-desktop-env-7' : root ? 'The answer is 42 [E1], answer.ts:1.' : 'Fixture response.')};
      const item = {type:'message',id:'msg_1',role:'assistant',content:[{type:'output_text',text,annotations:[]}]};
      return new Response(new TextEncoder().encode(frame({type:'response.output_item.added',output_index:0,item:{...item,content:[]}}) + frame({type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}}) + frame({type:'response.output_text.delta',output_index:0,content_index:0,delta:text}) + frame({type:'response.output_item.done',output_index:0,item}) + complete));
    };
    await import(${JSON.stringify(pathToFileURL(resolve('dist/live.js')).href)});
  `);
  await application.evaluate(({ app, safeStorage, utilityProcess }, { directory, fixture }) => {
    if (app.getPath('userData') !== directory) throw new Error('Fixture requires an isolated profile');
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const { randomUUID } = process.getBuiltinModule('node:crypto');
    const db = new DatabaseSync(directory + '/state/chatgpt.sqlite');
    if (!db.prepare('SELECT id FROM credentials').get()) db.prepare('INSERT INTO credentials VALUES (1, ?)').run(safeStorage.encryptString(JSON.stringify({
      version: 1, hostId: 'urn:uuid:' + randomUUID(), selectedModel: 'fixture-model',
      registration: { clientId: 'fixture-client', issuer: 'https://auth.openai.com', subject: 'fixture-subject', tokens: {
        idToken: 'fixture-verified-id', accessToken: 'desktop-live-oauth', refreshToken: 'desktop-live-refresh', expiresAt: Date.now() + 3600_000,
        scopes: ['openid','profile','email','offline_access','resource.invoke','chatgpt.tokens.use.direct'],
      } },
    })));
    db.close();
    const state = { catalog: 0, workers: 0 };
    (globalThis as unknown as { liveFixture: typeof state }).liveFixture = state;
    globalThis.fetch = async url => {
      if (String(url) !== 'https://api.openai.com/v1/models') throw new Error('Unexpected external request blocked by fixture');
      state.catalog++;
      return Response.json({ models: [{ slug: 'fixture-model', display_name: 'Fixture ChatGPT model', visibility: 'list' }] });
    };
    const fork = utilityProcess.fork;
    utilityProcess.fork = (modulePath, args, options) => {
      if (options?.serviceName === 'Athena ChatGPT conversation') { state.workers++; return fork(fixture, args, options); }
      return fork(modulePath, args, options);
    };
  }, { directory, fixture });
}
