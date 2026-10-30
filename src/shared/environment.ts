export const EPHEMERAL_NOTICE = 'Ephemeral investigation: derived output was not saved. Start a new conversation; this context cannot be reused.';
export const ENVIRONMENT_WARNING = 'Local inspection does not send contents to a model. External processing permits this exact file for this investigation only, including its delegated investigator and main agent. Derived output is ephemeral and this conversation cannot continue. A model may echo or paraphrase secrets. Revocation stops the job but cannot recall data already transmitted to a provider.';
export type EnvironmentAction = 'local' | 'external' | 'deny' | 'revoke';
export interface EnvironmentPermission {
  id: string;
  root: string;
  path: string;
  local: boolean;
  external: boolean;
  waiting: boolean;
  preview?: string;
}
