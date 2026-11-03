export const RESET_CONFIRMATION = 'Reset derived knowledge';
export const DELETE_CONVERSATION_CONFIRMATION = 'Delete this conversation';
export interface CleanupStatus { cleanupPending: boolean; lastDeletionAt?: string }
export interface MaintenanceStatus {
  retention: CleanupStatus & { verboseDays: number | null; expiredAttempts: number; eligibleAttempts: number };
  knowledge: CleanupStatus & { generation: string };
}
export interface MaintenanceBridge {
  snapshot(): Promise<MaintenanceStatus>;
  policy(verboseDays: number | null): Promise<MaintenanceStatus>;
  cleanup(): Promise<MaintenanceStatus>;
  reset(confirmation: string): Promise<MaintenanceStatus>;
  deleteConversation(conversationId: string, confirmation: string): Promise<MaintenanceStatus>;
}
