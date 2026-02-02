/**
 * Tests for agent factory and copilot agent.
 *
 * These tests verify that the agent factory correctly creates agents
 * and that the copilot agent has the expected interface.
 */

import { describe, it, expect } from 'bun:test'
import {
  getModelsForBackend,
  getDefaultModelForBackend,
  type AgentBackend,
} from '../agent-factory'

// Note: We test the constants directly without importing from copilot-agent
// to avoid loading all the dependencies that are needed at runtime

// ============================================================================
// Agent Factory Tests
// ============================================================================

describe('Agent Factory', () => {
  describe('getModelsForBackend', () => {
    it('returns Claude models for claude backend', () => {
      const models = getModelsForBackend('claude')
      expect(models.length).toBeGreaterThan(0)
      expect(models.some(m => m.id.includes('claude'))).toBe(true)
    })

    it('returns Copilot models for copilot backend', () => {
      const models = getModelsForBackend('copilot')
      expect(models.length).toBeGreaterThan(0)
      expect(models.some(m => m.id.includes('gpt'))).toBe(true)
    })

    it('returns models with required fields', () => {
      const backends: AgentBackend[] = ['claude', 'copilot']
      for (const backend of backends) {
        const models = getModelsForBackend(backend)
        for (const model of models) {
          expect(model.id).toBeDefined()
          expect(model.name).toBeDefined()
          expect(model.shortName).toBeDefined()
          expect(model.description).toBeDefined()
        }
      }
    })
  })

  describe('getDefaultModelForBackend', () => {
    it('returns a Claude model ID for claude backend', () => {
      const defaultModel = getDefaultModelForBackend('claude')
      expect(defaultModel).toContain('claude')
    })

    it('returns a GPT model ID for copilot backend', () => {
      const defaultModel = getDefaultModelForBackend('copilot')
      expect(defaultModel).toContain('gpt')
    })

    it('returns a model that exists in the models list', () => {
      const backends: AgentBackend[] = ['claude', 'copilot']
      for (const backend of backends) {
        const defaultModel = getDefaultModelForBackend(backend)
        const models = getModelsForBackend(backend)
        expect(models.some(m => m.id === defaultModel)).toBe(true)
      }
    })
  })
})

// ============================================================================
// Copilot Models Tests (using factory getModelsForBackend)
// ============================================================================

describe('Copilot Models', () => {
  it('includes GPT-4.1 as a model', () => {
    const models = getModelsForBackend('copilot')
    const gpt4 = models.find(m => m.id === 'gpt-4.1')
    expect(gpt4).toBeDefined()
    expect(gpt4?.name).toBe('GPT-4.1')
  })

  it('includes GPT-4.1 Mini as a model', () => {
    const models = getModelsForBackend('copilot')
    const gpt4Mini = models.find(m => m.id === 'gpt-4.1-mini')
    expect(gpt4Mini).toBeDefined()
    expect(gpt4Mini?.shortName).toBe('Mini')
  })

  it('includes o3-mini as a model', () => {
    const models = getModelsForBackend('copilot')
    const o3Mini = models.find(m => m.id === 'o3-mini')
    expect(o3Mini).toBeDefined()
  })

  it('has consistent structure for all models', () => {
    const models = getModelsForBackend('copilot')
    for (const model of models) {
      expect(typeof model.id).toBe('string')
      expect(typeof model.name).toBe('string')
      expect(typeof model.shortName).toBe('string')
      expect(typeof model.description).toBe('string')
      expect(model.id.length).toBeGreaterThan(0)
      expect(model.name.length).toBeGreaterThan(0)
    }
  })

  it('default copilot model is gpt-4.1', () => {
    const defaultModel = getDefaultModelForBackend('copilot')
    expect(defaultModel).toBe('gpt-4.1')
  })
})
