import type { InventoryBridge } from './inventory';
import type { ModelBridge } from './models';

export const MAX_TITLE_LENGTH = 100;
export const MAX_MESSAGE_LENGTH = 8_000;
export const MAX_WORKER_TEXT_LENGTH = 16_000;

export type MessageStatus = 'running' | 'complete' | 'failed' | 'cancelled';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status: MessageStatus;
}
export interface ConversationSummary {
  id: string;
  title: string;
}
export interface Conversation extends ConversationSummary {
  messages: Message[];
}
export interface Workspace {
  conversations: ConversationSummary[];
  selected: Conversation | null;
  activeConversationId: string | null;
  saveError?: string;
}
export interface DemoJob {
  messageId: string;
  text: string;
}
export interface DesktopBridge {
  inventory: InventoryBridge;
  models: ModelBridge;
  workspace(): Promise<Workspace>;
  select(conversationId: string): Promise<Workspace>;
  send(conversationId: string | null, text: string): Promise<Workspace>;
  cancel(): Promise<Workspace>;
  onChange(listener: () => void): () => void;
}
