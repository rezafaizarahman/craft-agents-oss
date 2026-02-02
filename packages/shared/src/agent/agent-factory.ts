/**
 * Agent Factory - Unified interface for creating agents with different backends.
 * 
 * This module provides a factory function for creating agents using either
 * the Claude SDK or the GitHub Copilot SDK, allowing users to choose their
 * preferred AI backend.
 */

import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import type { LoadedSource } from '../sources/types.ts';
import type { PermissionMode } from './mode-manager.ts';
import type { ThinkingLevel } from './thinking-levels.ts';
import type { Workspace } from '../config/storage.ts';
import type { SessionConfig as Session } from '../sessions/storage.ts';
import type { AuthRequest } from './session-scoped-tools.ts';

/**
 * Agent backend type.
 */
export type AgentBackend = 'claude' | 'copilot';

/**
 * Recovery message type for context building.
 */
export interface RecoveryMessage {
  type: 'user' | 'assistant';
  content: string;
}

/**
 * Unified agent configuration that works with both backends.
 */
export interface UnifiedAgentConfig {
  /** The AI backend to use */
  backend: AgentBackend;
  /** Workspace configuration */
  workspace: Workspace;
  /** Session configuration */
  session?: Session;
  /** Model to use (backend-specific model IDs) */
  model?: string;
  /** Thinking level for extended reasoning */
  thinkingLevel?: ThinkingLevel;
  /** Callback when SDK session ID is updated */
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;
  /** Callback when SDK session ID is cleared */
  onSdkSessionIdCleared?: () => void;
  /** Callback to get recovery messages */
  getRecoveryMessages?: () => RecoveryMessage[];
  /** Running in headless mode */
  isHeadless?: boolean;
  /** Debug mode configuration */
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };
  /** System prompt preset */
  systemPromptPreset?: 'default' | 'mini' | string;
  /** MCP token override (Claude only) */
  mcpToken?: string;
  /** GitHub token for authentication (Copilot only) */
  githubToken?: string;
  /** Path to the Copilot CLI executable (Copilot only) */
  cliPath?: string;
}

/**
 * Unified agent interface that both CraftAgent and CopilotAgent implement.
 */
export interface IAgent {
  // Callbacks
  onPermissionRequest: ((request: { requestId: string; toolName: string; command: string; description: string; type?: 'bash' }) => void) | null;
  onDebug: ((message: string) => void) | null;
  onPermissionModeChange: ((mode: PermissionMode) => void) | null;
  onPlanSubmitted: ((planPath: string) => void) | null;
  onAuthRequest: ((request: AuthRequest) => void) | null;
  onSourceChange: ((slug: string, source: LoadedSource | null) => void) | null;
  onSourcesListChange: ((sources: LoadedSource[]) => void) | null;
  onSourceActivationRequest: ((sourceSlug: string) => Promise<boolean>) | null;

  // Methods
  setThinkingLevel(level: ThinkingLevel): void;
  getThinkingLevel(): ThinkingLevel;
  setPermissionMode(mode: PermissionMode): void;
  getPermissionMode(): PermissionMode;
  cyclePermissionMode(): PermissionMode;
  setActiveSources(sources: LoadedSource[], activeSlugs: Set<string>): void;
  setTemporaryClarifications(clarifications: string | null): void;
  chat(userMessage: string, attachments?: FileAttachment[], _isRetry?: boolean): AsyncGenerator<AgentEvent>;
  forceAbort(reason?: any): Promise<void>;
  resolvePermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void;
  cancelPermission(requestId: string): void;
  clearPendingPermissions(): void;
  cleanup(): Promise<void>;
}

/**
 * Create an agent with the specified backend.
 * 
 * @param config - Unified agent configuration
 * @returns A promise that resolves to an agent instance
 * 
 * @example
 * ```typescript
 * // Create a Claude agent
 * const claudeAgent = await createAgent({
 *   backend: 'claude',
 *   workspace: myWorkspace,
 *   model: 'claude-sonnet-4-5-20250929',
 * });
 * 
 * // Create a Copilot agent
 * const copilotAgent = await createAgent({
 *   backend: 'copilot',
 *   workspace: myWorkspace,
 *   model: 'gpt-4.1',
 * });
 * ```
 */
export async function createAgent(config: UnifiedAgentConfig): Promise<IAgent> {
  if (config.backend === 'copilot') {
    const { CopilotAgent } = await import('./copilot-agent.ts');
    return new CopilotAgent({
      workspace: config.workspace,
      session: config.session,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      onSdkSessionIdUpdate: config.onSdkSessionIdUpdate,
      onSdkSessionIdCleared: config.onSdkSessionIdCleared,
      getRecoveryMessages: config.getRecoveryMessages,
      isHeadless: config.isHeadless,
      debugMode: config.debugMode,
      systemPromptPreset: config.systemPromptPreset,
      githubToken: config.githubToken,
      cliPath: config.cliPath,
    });
  }

  // Default to Claude
  const { CraftAgent } = await import('./craft-agent.ts');
  return new CraftAgent({
    workspace: config.workspace,
    session: config.session,
    mcpToken: config.mcpToken,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    onSdkSessionIdUpdate: config.onSdkSessionIdUpdate,
    onSdkSessionIdCleared: config.onSdkSessionIdCleared,
    getRecoveryMessages: config.getRecoveryMessages,
    isHeadless: config.isHeadless,
    debugMode: config.debugMode,
    systemPromptPreset: config.systemPromptPreset,
  });
}

/**
 * Check if a backend is available.
 * 
 * @param backend - The backend to check
 * @returns A promise that resolves to true if the backend is available
 */
export async function isBackendAvailable(backend: AgentBackend): Promise<boolean> {
  if (backend === 'copilot') {
    const { isCopilotAvailable } = await import('./copilot-agent.ts');
    return isCopilotAvailable();
  }
  
  // Claude is always available (requires API key but that's a separate check)
  return true;
}

/**
 * Get available models for a backend.
 * 
 * @param backend - The backend to get models for
 * @returns Array of available models
 */
export function getModelsForBackend(backend: AgentBackend): Array<{ id: string; name: string; shortName: string; description: string }> {
  if (backend === 'copilot') {
    return [
      { id: 'gpt-4.1', name: 'GPT-4.1', shortName: 'GPT-4.1', description: 'Most capable' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', shortName: 'Mini', description: 'Fast & efficient' },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', shortName: 'Sonnet', description: 'Balanced (via Copilot)' },
      { id: 'o3-mini', name: 'o3-mini', shortName: 'o3-mini', description: 'Reasoning model' },
    ];
  }
  
  // Claude models
  return [
    { id: 'claude-opus-4-5-20251101', name: 'Opus 4.5', shortName: 'Opus', description: 'Most capable' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', shortName: 'Sonnet', description: 'Balanced' },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', shortName: 'Haiku', description: 'Fast & efficient' },
  ];
}

/**
 * Get the default model for a backend.
 * 
 * @param backend - The backend to get the default model for
 * @returns The default model ID
 */
export function getDefaultModelForBackend(backend: AgentBackend): string {
  if (backend === 'copilot') {
    return 'gpt-4.1';
  }
  return 'claude-sonnet-4-5-20250929';
}
