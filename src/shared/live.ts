import type { Message as PiMessage } from '@earendil-works/pi-ai';
import type { ChatGPTUsage, ChatGPTFailure } from './chatgpt';
import type { SourceCitation, SourceOperation, SourceRequest, SourceResult } from './sources';

export const LIVE_LIMITS = { requests: 50, milliseconds: 15 * 60_000, historyBytes: 2 * 1024 * 1024, answerCharacters: 128_000, evidence: 200 } as const;
export interface ConversationBinding { model: string; registration: string }
export interface Evidence { id: string; citation: SourceCitation; text: string }
export type LiveStatus = 'complete' | 'failed' | 'cancelled' | 'partial' | 'limit';
export interface LiveResult { status: LiveStatus; text: string; history: PiMessage[]; usage?: ChatGPTUsage; usageComplete: boolean; requests: number; reason?: ChatGPTFailure }
export interface LiveStart { model: string; prompt: string; history: PiMessage[]; roots: { path: string; repositories: { name: string; path: string }[] }[] }
export type LiveRequest = { type: 'access'; id: number } | { type: 'source'; id: number; operation: SourceOperation; input: SourceRequest };
export type LiveWorkerMessage = LiveRequest | { type: 'usage'; request: number; usage?: ChatGPTUsage } | { type: 'progress'; text: string; activity: string } | { type: 'result'; result: LiveResult };
export type LiveParentMessage = { type: 'start'; job: LiveStart } | { type: 'reply'; id: number; token?: string; source?: SourceResult & { evidence: Evidence[] }; error?: string };
