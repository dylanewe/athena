import type { EnvironmentAction, EnvironmentPermission } from './environment';
import type { ApiSettingsBridge } from './api-models';
import type { InventoryBridge } from './inventory';
import type { ModelBridge } from './models';
import type { SourceBridge } from './sources';
import type { ChatGPTBridge, ChatGPTUsage } from './chatgpt';
import type { Evidence } from './live';
import type { KnowledgeBridge } from './knowledge';
import type { InvestigatorResult } from './investigation';

export const MAX_TITLE_LENGTH = 100;
export const MAX_MESSAGE_LENGTH = 8_000;
export const MAX_WORKER_TEXT_LENGTH = 16_000;

export type MessageStatus = 'running' | 'complete' | 'failed' | 'cancelled' | 'partial' | 'limit';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: MessageStatus;
  evidence?: Evidence[];
  investigation?: InvestigatorResult;
  usage?: ChatGPTUsage;
  usageComplete?: boolean;
  requests?: number;
  activity?: string;
  ephemeral?: boolean;
  knowledgePublication?: 'published' | 'withheld';
  knowledgeReferences?: { id: string; topic: string }[];
}
export interface ConversationSummary {
  id: string;
  title: string;
  kind?: 'demo' | 'chatgpt' | 'api-key';
  model?: string;
  sealed?: boolean;
}
export interface Conversation extends ConversationSummary {
  messages: Message[];
}
export interface Workspace {
  conversations: ConversationSummary[];
  selected: Conversation | null;
  activeConversationId: string | null;
  saveError?: string;
  environment?: EnvironmentPermission[];
}
export interface DemoJob {
  messageId: string;
  text: string;
}
export interface DesktopBridge {
  knowledge: KnowledgeBridge;
  apiModels: ApiSettingsBridge;
  chatgpt: ChatGPTBridge;
  sources: SourceBridge;
  inventory: InventoryBridge;
  models: ModelBridge;
  workspace(): Promise<Workspace>;
  select(conversationId: string): Promise<Workspace>;
  send(conversationId: string | null, text: string): Promise<Workspace>;
  cancel(): Promise<Workspace>;
  retry(messageId: string): Promise<Workspace>;
  environment(id: string, action: EnvironmentAction): Promise<Workspace>;
  onChange(listener: () => void): () => void;
}
