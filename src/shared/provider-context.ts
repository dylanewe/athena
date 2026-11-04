/** Top-level request fields that add provider-stored input outside Athena's local context. */
export function hasUnmanagedProviderContext(params: object): boolean {
  return Object.keys(params).some(key => /^(previous_response_id|conversation|prompt)$/iu.test(key));
}
export const UNMANAGED_PROVIDER_CONTEXT_ERROR = 'Unmanaged provider-side context is unsupported. Remove previous_response_id, conversation, and prompt from samplingParams and samplingParamsByThinkingLevel in Model settings or the trusted models.json, then save again. Athena must reconstruct and check all input locally.';
