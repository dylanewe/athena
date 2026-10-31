import type { Message as PiMessage } from '@earendil-works/pi-ai';
import type { ApiConversationConfig, ApiGrant, ModelRole } from './api-models';
import type { ChatGPTUsage, ChatGPTFailure } from './chatgpt';
import type { Exploration } from './investigation';
import type { KnowledgeRequest, KnowledgeResult } from './knowledge';
import type { SourceCitation, SourceOperation, SourceRequest, SourceResult } from './sources';

export const LIVE_LIMITS = { requests: 50, milliseconds: 15 * 60_000, historyBytes: 2 * 1024 * 1024, answerCharacters: 128_000, evidence: 200 } as const;
export interface ConversationBinding { model: string; registration: string; apiKey?: ApiConversationConfig }
export interface Evidence { id: string; citation: SourceCitation; text: string }
export type LiveStatus = 'complete' | 'failed' | 'cancelled' | 'partial' | 'limit';
export interface LiveResult { status: LiveStatus; text: string; history: PiMessage[]; usage?: ChatGPTUsage; usageComplete: boolean; requests: number; reason?: ChatGPTFailure; exploration?: Exploration; title?: string; knowledgePublication?: 'published' | 'withheld'; knowledgeReferences?: { id: string; topic: string }[] }
export interface LiveStart { apiKey?: ApiConversationConfig; model: string; prompt: string; history: PiMessage[]; roots: { path: string; repositories: { name: string; path: string }[] }[]; needsTitle?: boolean; titlePrompt?: string }
export type LiveRequest = { type: 'access'; id: number; role?: ModelRole; contextBytes?: number } | { type: 'source'; id: number; operation: SourceOperation; input: SourceRequest } | { type: 'inspect'; id: number; ids: string[] } | { type: 'knowledge'; id: number; input: KnowledgeRequest };
export type LiveCheckpoint = Pick<LiveResult, 'exploration' | 'title'>;
export type LiveWorkerMessage = LiveRequest | { type: 'checkpoint'; checkpoint: LiveCheckpoint } | { type: 'usage'; request: number; usage?: ChatGPTUsage } | { type: 'progress'; text: string; activity: string } | { type: 'result'; result: LiveResult };
export type LiveParentMessage = { type: 'start'; job: LiveStart } | { type: 'reply'; id: number; token?: string; grant?: ApiGrant; ephemeral?: boolean; source?: SourceResult & { evidence: Evidence[] }; evidence?: Evidence[]; knowledge?: KnowledgeResult; error?: string };
