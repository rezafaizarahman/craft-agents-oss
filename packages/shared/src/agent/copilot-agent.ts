/**
 * CopilotAgent - GitHub Copilot SDK integration for Craft Agents
 * 
 * This module provides integration with the GitHub Copilot SDK, allowing users
 * to use GitHub Copilot as an alternative to Claude for agent interactions.
 * 
 * The Copilot SDK communicates with the Copilot CLI via JSON-RPC, providing
 * access to the same agentic capabilities available in Copilot CLI.
 */

import { CopilotClient, CopilotSession, defineTool, type SessionConfig, type MessageOptions, type SessionEvent, type Tool, type MCPServerConfig, type PermissionHandler, type PermissionRequest, type PermissionRequestResult } from '@github/copilot-sdk';
import { z } from 'zod';
import type { AgentEvent } from '@craft-agent/core/types';
import { debug } from '../utils/debug.ts';
import { getSystemPrompt, getDateTimeContext, getWorkingDirectoryContext } from '../prompts/system.ts';
import { loadStoredConfig, loadConfigDefaults, type Workspace } from '../config/storage.ts';
import type { SessionConfig as Session } from '../sessions/storage.ts';
import { updatePreferences, loadPreferences, formatPreferencesForPrompt, type UserPreferences } from '../config/preferences.ts';
import type { FileAttachment } from '../utils/files.ts';
import {
  getSessionPlansDir,
  getLastPlanFilePath,
  clearPlanFileState,
  registerSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  getSessionScopedTools,
  cleanupSessionScopedTools,
  type AuthRequest,
} from './session-scoped-tools.ts';
import {
  getPermissionMode,
  setPermissionMode,
  cyclePermissionMode,
  initializeModeState,
  cleanupModeState,
  formatSessionState,
  shouldAllowToolInMode,
  blockWithReason,
  isApiEndpointAllowed,
  type PermissionMode,
  PERMISSION_MODE_CONFIG,
  SAFE_MODE_CONFIG,
} from './mode-manager.ts';
import { type PermissionsContext, permissionsConfigCache } from './permissions-config.ts';
import { getSessionPlansPath, getSessionPath } from '../sessions/storage.ts';
import type { LoadedSource } from '../sources/types.ts';
import { type ThinkingLevel, getThinkingTokens, DEFAULT_THINKING_LEVEL } from './thinking-levels.ts';

// Re-export types for consistency with craft-agent.ts
export type { AgentEvent };
export type { LoadedSource };

/**
 * Reason for aborting agent execution.
 */
export enum CopilotAbortReason {
  UserStop = 'user_stop',
  PlanSubmitted = 'plan_submitted',
  AuthRequest = 'auth_request',
  Redirect = 'redirect',
  SourceActivated = 'source_activated',
}

/**
 * Recovery message type for context building.
 */
export interface RecoveryMessage {
  type: 'user' | 'assistant';
  content: string;
}

/**
 * Configuration for creating a CopilotAgent.
 */
export interface CopilotAgentConfig {
  workspace: Workspace;
  session?: Session;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  onSdkSessionIdUpdate?: (sdkSessionId: string) => void;
  onSdkSessionIdCleared?: () => void;
  getRecoveryMessages?: () => RecoveryMessage[];
  isHeadless?: boolean;
  debugMode?: {
    enabled: boolean;
    logFilePath?: string;
  };
  systemPromptPreset?: 'default' | 'mini' | string;
  /** GitHub token for authentication (optional - uses CLI auth if not provided) */
  githubToken?: string;
  /** Path to the Copilot CLI executable (optional - searches PATH if not provided) */
  cliPath?: string;
}

// Handle preferences update (extracted for use in tool)
function handleUpdatePreferences(input: Record<string, unknown>): string {
  const updates: Partial<UserPreferences> = {};

  if (input.name && typeof input.name === 'string') {
    updates.name = input.name;
  }
  if (input.timezone && typeof input.timezone === 'string') {
    updates.timezone = input.timezone;
  }
  if (input.language && typeof input.language === 'string') {
    updates.language = input.language;
  }

  // Handle location fields
  if (input.city || input.region || input.country) {
    updates.location = {};
    if (input.city && typeof input.city === 'string') {
      updates.location.city = input.city;
    }
    if (input.region && typeof input.region === 'string') {
      updates.location.region = input.region;
    }
    if (input.country && typeof input.country === 'string') {
      updates.location.country = input.country;
    }
  }

  // Handle notes (append to existing)
  if (input.notes && typeof input.notes === 'string') {
    const current = loadPreferences();
    const existingNotes = current.notes || '';
    const newNote = input.notes;
    updates.notes = existingNotes
      ? `${existingNotes}\n- ${newNote}`
      : `- ${newNote}`;
  }

  // Check if anything was actually updated
  const fields = Object.keys(updates).filter(k => k !== 'location');
  if (updates.location) {
    fields.push(...Object.keys(updates.location).map(k => `location.${k}`));
  }

  if (fields.length === 0) {
    return 'No preferences were updated (no valid fields provided)';
  }

  updatePreferences(updates);
  return `Updated user preferences: ${fields.join(', ')}`;
}

// Copilot SDK-compatible preferences tool
const updateUserPreferencesTool = defineTool('update_user_preferences', {
  description: `Update stored user preferences. Use this when you learn information about the user that would be helpful to remember for future conversations. This includes their name, timezone, location, preferred language, or any other relevant notes. Only update fields you have confirmed information about - don't guess.`,
  parameters: z.object({
    name: z.string().optional().describe("The user's preferred name or how they'd like to be addressed"),
    timezone: z.string().optional().describe("The user's timezone in IANA format (e.g., 'America/New_York', 'Europe/London')"),
    city: z.string().optional().describe("The user's city"),
    region: z.string().optional().describe("The user's state/region/province"),
    country: z.string().optional().describe("The user's country"),
    language: z.string().optional().describe("The user's preferred language for responses"),
    notes: z.string().optional().describe('Additional notes about the user that would be helpful to remember (preferences, context, etc.). This appends to existing notes.'),
  }),
  handler: async (args) => {
    try {
      const result = handleUpdatePreferences(args);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return `Failed to update preferences: ${message}`;
    }
  },
});

/**
 * Copilot models available for use.
 * These map to models supported by the GitHub Copilot API.
 */
export const COPILOT_MODELS = [
  { id: 'gpt-4.1', name: 'GPT-4.1', shortName: 'GPT-4.1', description: 'Most capable' },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', shortName: 'Mini', description: 'Fast & efficient' },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', shortName: 'Sonnet', description: 'Balanced (via Copilot)' },
  { id: 'o3-mini', name: 'o3-mini', shortName: 'o3-mini', description: 'Reasoning model' },
];

export const DEFAULT_COPILOT_MODEL = 'gpt-4.1';

/**
 * CopilotAgent - GitHub Copilot SDK-based agent implementation.
 * 
 * This class provides a similar interface to CraftAgent but uses the
 * GitHub Copilot SDK instead of the Claude SDK.
 */
export class CopilotAgent {
  private config: CopilotAgentConfig;
  private client: CopilotClient | null = null;
  private currentSession: CopilotSession | null = null;
  private sessionId: string | null = null;
  private isHeadless: boolean = false;
  private lastAbortReason: CopilotAbortReason | null = null;
  private pendingPermissions: Map<string, { resolve: (allowed: boolean, alwaysAllow?: boolean) => void }> = new Map();
  private alwaysAllowedCommands: Set<string> = new Set();
  private alwaysAllowedDomains: Set<string> = new Set();
  private sourceMcpServers: Record<string, MCPServerConfig> = {};
  private activeSourceServerNames: Set<string> = new Set();
  private intendedActiveSlugs: Set<string> = new Set();
  private allSources: LoadedSource[] = [];
  private knownSourceSlugs: Set<string> = new Set();
  private temporaryClarifications: string | null = null;
  private thinkingLevel: ThinkingLevel = 'think';
  private pinnedPreferencesPrompt: string | null = null;
  private preferencesDriftNotified: boolean = false;

  // Callbacks
  public onPermissionRequest: ((request: { requestId: string; toolName: string; command: string; description: string; type?: 'bash' }) => void) | null = null;
  public onDebug: ((message: string) => void) | null = null;
  public onPermissionModeChange: ((mode: PermissionMode) => void) | null = null;
  public onPlanSubmitted: ((planPath: string) => void) | null = null;
  public onAuthRequest: ((request: AuthRequest) => void) | null = null;
  public onSourceChange: ((slug: string, source: LoadedSource | null) => void) | null = null;
  public onSourcesListChange: ((sources: LoadedSource[]) => void) | null = null;
  public onSourceActivationRequest: ((sourceSlug: string) => Promise<boolean>) | null = null;

  private get modeSessionId(): string {
    return this.config.session?.id || `temp-${Date.now()}`;
  }

  private get workspaceRootPath(): string {
    return this.config.workspace.rootPath;
  }

  constructor(config: CopilotAgentConfig) {
    const model = config.session?.model ?? config.model ?? DEFAULT_COPILOT_MODEL;
    this.config = { ...config, model };
    this.isHeadless = config.isHeadless ?? false;

    debug(`[CopilotAgent] Using model: ${model}`);

    if (config.thinkingLevel) {
      this.thinkingLevel = config.thinkingLevel;
    }

    if (config.session?.sdkSessionId) {
      this.sessionId = config.session.sdkSessionId;
    }

    // Initialize permission mode state
    const sessionId = this.modeSessionId;
    const globalDefaults = loadConfigDefaults();
    const initialMode: PermissionMode = config.session?.permissionMode ?? globalDefaults.workspaceDefaults.permissionMode;

    initializeModeState(sessionId, initialMode, {
      onStateChange: (state) => {
        this.onPermissionModeChange?.(state.permissionMode);
      },
    });

    // Register session-scoped tool callbacks
    registerSessionScopedToolCallbacks(sessionId, {
      onPlanSubmitted: (planPath) => {
        this.onDebug?.(`[CopilotAgent] onPlanSubmitted received: ${planPath}`);
        this.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request) => {
        this.onDebug?.(`[CopilotAgent] onAuthRequest received: ${request.sourceSlug} (type: ${request.type})`);
        this.onAuthRequest?.(request);
      },
    });
  }

  /**
   * Set the session-level thinking level.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
    this.onDebug?.(`[CopilotAgent] Thinking level: ${level}`);
  }

  /**
   * Get the current session-level thinking level.
   */
  getThinkingLevel(): ThinkingLevel {
    return this.thinkingLevel;
  }

  /**
   * Set the permission mode for the current session.
   */
  setPermissionMode(mode: PermissionMode): void {
    setPermissionMode(this.modeSessionId, mode);
  }

  /**
   * Get the current permission mode.
   */
  getPermissionMode(): PermissionMode {
    return getPermissionMode(this.modeSessionId);
  }

  /**
   * Cycle through permission modes.
   */
  cyclePermissionMode(): PermissionMode {
    return cyclePermissionMode(this.modeSessionId);
  }

  /**
   * Set sources for the session.
   */
  setActiveSources(sources: LoadedSource[], activeSlugs: Set<string>): void {
    this.allSources = sources;
    this.activeSourceServerNames = new Set(activeSlugs);
    this.intendedActiveSlugs = new Set(activeSlugs);

    // Build MCP server configs from active sources
    this.sourceMcpServers = {};
    for (const source of sources) {
      if (activeSlugs.has(source.config.slug)) {
        // Convert source to MCP server config
        if (source.config.mcp) {
          if (source.config.mcp.type === 'stdio') {
            this.sourceMcpServers[source.config.slug] = {
              type: 'local',
              command: source.config.mcp.command,
              args: source.config.mcp.args || [],
              env: source.config.mcp.env,
              tools: ['*'], // Allow all tools from this server
            };
          } else if (source.config.mcp.type === 'http' || source.config.mcp.type === 'sse') {
            this.sourceMcpServers[source.config.slug] = {
              type: source.config.mcp.type,
              url: source.config.mcp.url,
              headers: source.config.mcp.headers,
              tools: ['*'],
            };
          }
        }
      }
    }
  }

  /**
   * Set temporary clarifications for the session.
   */
  setTemporaryClarifications(clarifications: string | null): void {
    this.temporaryClarifications = clarifications;
  }

  /**
   * Initialize the Copilot client.
   */
  private async ensureClient(): Promise<CopilotClient> {
    if (!this.client) {
      this.client = new CopilotClient({
        cliPath: this.config.cliPath,
        cwd: this.workspaceRootPath,
        githubToken: this.config.githubToken,
        useLoggedInUser: !this.config.githubToken, // Use logged-in user if no token provided
        autoStart: true,
        autoRestart: true,
      });
    }
    return this.client;
  }

  /**
   * Build the system prompt for the session.
   */
  private buildSystemPrompt(): string {
    const preferencesPrompt = this.pinnedPreferencesPrompt ?? formatPreferencesForPrompt();
    
    if (this.config.systemPromptPreset === 'mini') {
      return getSystemPrompt(undefined, undefined, this.workspaceRootPath, undefined, 'mini');
    }
    
    return getSystemPrompt(
      preferencesPrompt,
      this.config.debugMode,
      this.workspaceRootPath,
      this.config.session?.workingDirectory
    );
  }

  /**
   * Build the text prompt with context.
   */
  private buildTextPrompt(userMessage: string, attachments?: FileAttachment[]): string {
    const sessionId = this.config.session?.id || `temp-${Date.now()}`;
    const permissionMode = getPermissionMode(sessionId);
    
    // Build context sections
    const dateContext = getDateTimeContext();
    const workingDirContext = getWorkingDirectoryContext(
      this.workspaceRootPath,
      this.config.session?.workingDirectory
    );
    
    const sessionState = formatSessionState(sessionId, permissionMode, {
      allSources: this.allSources,
      activeSlugs: this.intendedActiveSlugs,
      knownSourceSlugs: this.knownSourceSlugs,
      temporaryClarifications: this.temporaryClarifications,
    });

    let prompt = `${dateContext}\n${workingDirContext}\n${sessionState}\n\n${userMessage}`;

    // Append text file contents if any
    if (attachments?.length) {
      const textAttachments = attachments.filter(a => a.type === 'text');
      for (const attachment of textAttachments) {
        prompt += `\n\n<attached_file name="${attachment.name}">\n${attachment.content}\n</attached_file>`;
      }
    }

    return prompt;
  }

  /**
   * Convert Copilot session events to AgentEvents.
   */
  private convertSessionEvent(event: SessionEvent): AgentEvent[] {
    const events: AgentEvent[] = [];

    switch (event.type) {
      case 'assistant.message_delta':
        // Streaming text content
        if (event.data?.deltaContent) {
          events.push({
            type: 'text',
            text: event.data.deltaContent,
          });
        }
        break;

      case 'assistant.message':
        // Final message - may include content we haven't streamed yet
        if (event.data?.content && typeof event.data.content === 'string') {
          // For non-streaming mode or final content
          events.push({
            type: 'text',
            text: event.data.content,
          });
        }
        break;

      case 'tool.start':
        // Tool invocation started
        if (event.data) {
          events.push({
            type: 'tool_use',
            toolUseId: event.data.toolCallId || `tool-${Date.now()}`,
            toolName: event.data.toolName || 'unknown',
            input: event.data.arguments || {},
          });
        }
        break;

      case 'tool.result':
        // Tool completed
        if (event.data) {
          events.push({
            type: 'tool_result',
            toolUseId: event.data.toolCallId || `tool-${Date.now()}`,
            toolName: event.data.toolName || 'unknown',
            result: typeof event.data.result === 'string' ? event.data.result : JSON.stringify(event.data.result),
            isError: event.data.resultType === 'failure' || event.data.resultType === 'rejected',
            input: event.data.arguments || {},
          });
        }
        break;

      case 'session.idle':
        // Session is idle - processing complete
        events.push({ type: 'complete' });
        break;

      case 'session.error':
        // Error occurred
        events.push({
          type: 'error',
          message: event.data?.message || 'Unknown error',
        });
        break;

      case 'session.abort':
        // Session was aborted
        events.push({
          type: 'info',
          message: 'Session aborted',
        });
        events.push({ type: 'complete' });
        break;

      // Ignore other event types for now
      default:
        debug(`[CopilotAgent] Unhandled event type: ${event.type}`);
    }

    return events;
  }

  /**
   * Create the permission handler for the session.
   */
  private createPermissionHandler(): PermissionHandler {
    return async (request: PermissionRequest): Promise<PermissionRequestResult> => {
      const sessionId = this.modeSessionId;
      const permissionMode = getPermissionMode(sessionId);

      this.onDebug?.(`[CopilotAgent] Permission request: ${request.kind} (mode=${permissionMode})`);

      // Build permissions context
      const permissionsContext: PermissionsContext = {
        workspaceRootPath: this.workspaceRootPath,
        activeSourceSlugs: Array.from(this.activeSourceServerNames),
      };

      // In 'allow-all' mode, allow everything
      if (permissionMode === 'allow-all') {
        return { kind: 'approved' };
      }

      // In 'safe' mode, check against read-only allowlist
      if (permissionMode === 'safe') {
        // Only allow read operations
        if (request.kind === 'read') {
          return { kind: 'approved' };
        }
        return { 
          kind: 'denied-by-rules',
          rules: [{ reason: 'Write operations are blocked in safe mode' }],
        };
      }

      // In 'ask' mode, check if the operation is allowed
      if (request.kind === 'read') {
        return { kind: 'approved' };
      }

      // For write/shell operations, ask for permission
      if (this.onPermissionRequest) {
        const requestId = `perm-${Date.now()}`;
        const command = (request as any).command || (request as any).path || 'unknown';
        
        return new Promise((resolve) => {
          this.pendingPermissions.set(requestId, {
            resolve: (allowed) => {
              resolve(allowed ? { kind: 'approved' } : { kind: 'denied-interactively-by-user' });
            },
          });

          this.onPermissionRequest!({
            requestId,
            toolName: request.kind,
            command,
            description: `${request.kind}: ${command}`,
          });
        });
      }

      // No handler - deny by default
      return { kind: 'denied-no-approval-rule-and-could-not-request-from-user' };
    };
  }

  /**
   * Chat with the agent.
   * 
   * This is the main entry point for sending messages to the agent.
   * Returns an async generator that yields AgentEvents.
   */
  async *chat(
    userMessage: string,
    attachments?: FileAttachment[],
    _isRetry: boolean = false
  ): AsyncGenerator<AgentEvent> {
    try {
      const sessionId = this.config.session?.id || `temp-${Date.now()}`;

      // Pin system prompt on first chat
      const currentPreferencesPrompt = formatPreferencesForPrompt();
      if (this.pinnedPreferencesPrompt === null) {
        this.pinnedPreferencesPrompt = currentPreferencesPrompt;
        debug('[CopilotAgent] Pinned system prompt components');
      } else if (currentPreferencesPrompt !== this.pinnedPreferencesPrompt && !this.preferencesDriftNotified) {
        yield {
          type: 'info',
          message: 'Note: Your preferences changed since this session started. Start a new session to apply changes.',
        };
        this.preferencesDriftNotified = true;
      }

      // Validate we have something to send
      if (!userMessage.trim() && (!attachments || attachments.length === 0)) {
        yield { type: 'error', message: 'Cannot send empty message' };
        yield { type: 'complete' };
        return;
      }

      // Ensure client is initialized
      const client = await this.ensureClient();

      // Build session configuration
      const isMiniAgent = this.config.systemPromptPreset === 'mini';
      const model = this.config.model || DEFAULT_COPILOT_MODEL;

      const sessionConfig: SessionConfig = {
        sessionId: this.sessionId || undefined,
        model,
        workingDirectory: this.config.session?.sdkCwd ??
          (sessionId ? getSessionPath(this.workspaceRootPath, sessionId) : this.workspaceRootPath),
        streaming: true,
        systemMessage: {
          mode: 'append',
          content: this.buildSystemPrompt(),
        },
        tools: isMiniAgent ? [] : [updateUserPreferencesTool],
        mcpServers: this.sourceMcpServers,
        onPermissionRequest: this.createPermissionHandler(),
        hooks: {
          onPreToolUse: async (input) => {
            const permissionMode = getPermissionMode(sessionId);
            this.onDebug?.(`[CopilotAgent] PreToolUse: ${input.toolName} (mode=${permissionMode})`);

            const permissionsContext: PermissionsContext = {
              workspaceRootPath: this.workspaceRootPath,
              activeSourceSlugs: Array.from(this.activeSourceServerNames),
            };

            // Check permission mode
            const plansFolderPath = sessionId ? getSessionPlansPath(this.workspaceRootPath, sessionId) : undefined;
            const result = shouldAllowToolInMode(
              input.toolName,
              input.toolArgs,
              permissionMode,
              { plansFolderPath, permissionsContext }
            );

            if (!result.allowed) {
              return {
                permissionDecision: 'deny',
                permissionDecisionReason: result.reason,
              };
            }

            return { permissionDecision: 'allow' };
          },
        },
      };

      // Create or resume session
      if (this.currentSession && this.sessionId && !_isRetry) {
        debug(`[CopilotAgent] Resuming session: ${this.sessionId}`);
      } else {
        debug(`[CopilotAgent] Creating new session`);
        this.currentSession = await client.createSession(sessionConfig);
        this.sessionId = this.currentSession.sessionId;
        this.config.onSdkSessionIdUpdate?.(this.sessionId);
      }

      // Build the prompt
      const prompt = this.buildTextPrompt(userMessage, attachments);

      // Set up event handling
      const eventQueue: SessionEvent[] = [];
      let resolveEvent: (() => void) | null = null;
      let sessionEnded = false;

      const unsubscribe = this.currentSession.on((event: SessionEvent) => {
        eventQueue.push(event);
        if (event.type === 'session.idle' || event.type === 'session.error' || event.type === 'session.abort') {
          sessionEnded = true;
        }
        resolveEvent?.();
      });

      try {
        // Send the message
        const messageOptions: MessageOptions = {
          prompt,
          mode: 'enqueue',
        };

        // Add file attachments if any
        if (attachments?.length) {
          const fileAttachments = attachments.filter(a => a.type === 'text' || a.type === 'image' || a.type === 'pdf');
          // Note: Copilot SDK handles attachments differently than Claude SDK
          // For now, we include text content inline in the prompt
        }

        this.currentSession.send(messageOptions);

        // Yield events as they come in
        while (!sessionEnded) {
          if (eventQueue.length > 0) {
            const event = eventQueue.shift()!;
            const agentEvents = this.convertSessionEvent(event);
            for (const agentEvent of agentEvents) {
              yield agentEvent;
            }
          } else {
            // Wait for next event
            await new Promise<void>((resolve) => {
              resolveEvent = resolve;
              // Timeout to check periodically
              setTimeout(resolve, 100);
            });
          }
        }

        // Process remaining events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          const agentEvents = this.convertSessionEvent(event);
          for (const agentEvent of agentEvents) {
            yield agentEvent;
          }
        }
      } finally {
        unsubscribe();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debug(`[CopilotAgent] Error: ${message}`);
      yield { type: 'error', message };
      yield { type: 'complete' };
    }
  }

  /**
   * Force abort the current query.
   */
  async forceAbort(reason: CopilotAbortReason = CopilotAbortReason.UserStop): Promise<void> {
    this.lastAbortReason = reason;
    if (this.currentSession) {
      try {
        await this.currentSession.abort();
      } catch (error) {
        debug(`[CopilotAgent] Abort error: ${error}`);
      }
    }
  }

  /**
   * Get the last abort reason.
   */
  getLastAbortReason(): CopilotAbortReason | null {
    return this.lastAbortReason;
  }

  /**
   * Resolve a pending permission request.
   */
  resolvePermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(allowed, alwaysAllow);
      this.pendingPermissions.delete(requestId);
    }
  }

  /**
   * Cancel a pending permission request.
   */
  cancelPermission(requestId: string): void {
    this.resolvePermission(requestId, false);
  }

  /**
   * Clear all pending permissions.
   */
  clearPendingPermissions(): void {
    for (const [id, pending] of this.pendingPermissions) {
      pending.resolve(false);
    }
    this.pendingPermissions.clear();
  }

  /**
   * Cleanup resources.
   */
  async cleanup(): Promise<void> {
    this.clearPendingPermissions();

    if (this.currentSession) {
      try {
        await this.currentSession.destroy();
      } catch (error) {
        debug(`[CopilotAgent] Session destroy error: ${error}`);
      }
      this.currentSession = null;
    }

    if (this.client) {
      try {
        await this.client.stop();
      } catch (error) {
        debug(`[CopilotAgent] Client stop error: ${error}`);
      }
      this.client = null;
    }

    // Cleanup mode state
    cleanupModeState(this.modeSessionId);
    unregisterSessionScopedToolCallbacks(this.modeSessionId);
    cleanupSessionScopedTools(this.modeSessionId);
  }
}

/**
 * Check if Copilot CLI is available.
 */
export async function isCopilotAvailable(): Promise<boolean> {
  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    await execAsync('copilot --version', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Copilot authentication status.
 */
export async function getCopilotAuthStatus(): Promise<{ isAuthenticated: boolean; login?: string }> {
  try {
    const client = new CopilotClient({ autoStart: true });
    const status = await client.getAuthStatus();
    await client.stop();
    return {
      isAuthenticated: status.isAuthenticated,
      login: status.login,
    };
  } catch {
    return { isAuthenticated: false };
  }
}
