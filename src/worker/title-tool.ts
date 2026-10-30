import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { MAX_TITLE_LENGTH } from '../shared/contracts';
import { checkBeforeModelSend } from '../main/secret-check';

/** Naming is a tool of the current agent job, never its own provider request. */
export function titleTool(save: (title: string) => void): AgentTool {
  let saved = false;
  return {
    name: 'set_conversation_title', label: 'Name conversation',
    description: 'Save a short descriptive conversation title derived from the initial user question. Available only until a model title is saved. No extra naming job or provider.',
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: MAX_TITLE_LENGTH }) }, { additionalProperties: false }),
    async execute(_id, params) {
      const value = (params as { title: string }).title.trim().replace(/\s+/gu, ' ');
      if (saved || !value || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Title unavailable or invalid.');
      checkBeforeModelSend(value);
      save(value); saved = true;
      return { content: [{ type: 'text', text: 'Title saved with this job.' }], details: {} };
    },
  };
}
