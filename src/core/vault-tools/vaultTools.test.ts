import { App, TFile, TFolder } from 'obsidian'

import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { VaultTools } from './vaultTools'

function makeFile(path: string, name: string): TFile {
  const f = new (TFile as unknown as new () => TFile)()
  Object.assign(f, { path, name })
  return f
}

function makeFolder(path: string, children: (TFile | TFolder)[] = []): TFolder {
  const f = new (TFolder as unknown as new () => TFolder)()
  Object.assign(f, { path, name: path.split('/').pop() ?? path, children })
  return f
}

function makeApp(vaultOverrides: Record<string, unknown> = {}): App {
  return {
    vault: {
      getAbstractFileByPath: jest.fn(),
      getRoot: jest.fn(),
      getFiles: jest.fn().mockReturnValue([]),
      cachedRead: jest.fn().mockResolvedValue(''),
      ...vaultOverrides,
    },
  } as unknown as App
}

describe('VaultTools', () => {
  describe('isNativeTool', () => {
    it('returns true only for exact vault tool names', () => {
      const vt = new VaultTools(makeApp(), jest.fn())
      expect(vt.isNativeTool('vault_read_file')).toBe(true)
      expect(vt.isNativeTool('vault_list_directory')).toBe(true)
      expect(vt.isNativeTool('vault_search_files')).toBe(true)
      expect(vt.isNativeTool('vault_search_content')).toBe(true)
      expect(vt.isNativeTool('mcp__server__tool')).toBe(false)
      expect(vt.isNativeTool('vault__read_file')).toBe(false)
      expect(vt.isNativeTool('vault_unknown')).toBe(false)
    })
  })

  describe('listTools', () => {
    it('returns 4 tool definitions', () => {
      const vt = new VaultTools(makeApp(), jest.fn())
      expect(vt.listTools()).toHaveLength(4)
    })
  })

  describe('vault_read_file', () => {
    it('returns file content on success', async () => {
      const file = makeFile('notes/foo.md', 'foo.md')
      const app = makeApp({
        getAbstractFileByPath: jest.fn().mockReturnValue(file),
        cachedRead: jest.fn().mockResolvedValue('hello'),
      })
      const vt = new VaultTools(app, jest.fn())
      const result = await vt.callTool('vault_read_file', { path: 'notes/foo.md' })
      expect(result.status).toBe(ToolCallResponseStatus.Success)
      if (result.status === ToolCallResponseStatus.Success) {
        expect(result.data.text).toBe('hello')
      }
    })

    it('returns error when path not found', async () => {
      const app = makeApp({ getAbstractFileByPath: jest.fn().mockReturnValue(null) })
      const vt = new VaultTools(app, jest.fn())
      const result = await vt.callTool('vault_read_file', { path: 'missing.md' })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
    })
  })

  describe('vault_list_directory', () => {
    it('lists root when no path given', async () => {
      const folder = makeFolder('/')
      const app = makeApp({ getRoot: jest.fn().mockReturnValue(folder) })
      const vt = new VaultTools(app, jest.fn())
      const result = await vt.callTool('vault_list_directory', {})
      expect(result.status).toBe(ToolCallResponseStatus.Success)
    })

    it('returns error when path resolves to a file', async () => {
      const file = makeFile('notes/foo.md', 'foo.md')
      const app = makeApp({ getAbstractFileByPath: jest.fn().mockReturnValue(file) })
      const vt = new VaultTools(app, jest.fn())
      const result = await vt.callTool('vault_list_directory', { path: 'notes/foo.md' })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
    })
  })

  describe('vault_search_files', () => {
    it('returns matching file paths', async () => {
      const files = [makeFile('notes/alpha.md', 'alpha.md'), makeFile('notes/beta.md', 'beta.md')]
      const app = makeApp({ getFiles: jest.fn().mockReturnValue(files) })
      const vt = new VaultTools(app, jest.fn())
      const result = await vt.callTool('vault_search_files', { query: 'alpha' })
      expect(result.status).toBe(ToolCallResponseStatus.Success)
      if (result.status === ToolCallResponseStatus.Success) {
        expect(result.data.text).toContain('notes/alpha.md')
        expect(result.data.text).not.toContain('notes/beta.md')
      }
    })

    it('matches case-insensitively', async () => {
      const files = [makeFile('notes/Python-guide.md', 'Python-guide.md')]
      const app = makeApp({ getFiles: jest.fn().mockReturnValue(files) })
      const vt = new VaultTools(app, jest.fn())
      const result = await vt.callTool('vault_search_files', { query: 'python' })
      expect(result.status).toBe(ToolCallResponseStatus.Success)
      if (result.status === ToolCallResponseStatus.Success) {
        expect(result.data.text).toContain('notes/Python-guide.md')
      }
    })

    it('truncates results beyond 50', async () => {
      const files = Array.from({ length: 60 }, (_, i) =>
        makeFile(`notes/note${i}.md`, `note${i}.md`),
      )
      const app = makeApp({ getFiles: jest.fn().mockReturnValue(files) })
      const vt = new VaultTools(app, jest.fn())
      const result = await vt.callTool('vault_search_files', { query: 'note' })
      expect(result.status).toBe(ToolCallResponseStatus.Success)
      if (result.status === ToolCallResponseStatus.Success) {
        expect(result.data.text).toContain('10 more results truncated')
      }
    })

    it('returns error for empty query', async () => {
      const vt = new VaultTools(makeApp(), jest.fn())
      const result = await vt.callTool('vault_search_files', { query: '' })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
    })
  })

  describe('vault_search_content', () => {
    it('returns RAG results when available', async () => {
      const ragResults = [
        { path: 'notes/a.md', content: 'matched chunk text', similarity: 0.9, metadata: { startLine: 1, endLine: 5 } },
      ]
      const getRagEngine = jest.fn().mockResolvedValue({
        processQuery: jest.fn().mockResolvedValue(ragResults),
      })
      const vt = new VaultTools(makeApp(), getRagEngine)
      const result = await vt.callTool('vault_search_content', { query: 'foo' })
      expect(result.status).toBe(ToolCallResponseStatus.Success)
      if (result.status === ToolCallResponseStatus.Success) {
        expect(result.data.text).toContain('notes/a.md')
        expect(result.data.text).toContain('matched chunk text')
      }
    })

    it('returns error when RAG fails', async () => {
      const getRagEngine = jest.fn().mockRejectedValue(new Error('no index'))
      const vt = new VaultTools(makeApp(), getRagEngine)
      const result = await vt.callTool('vault_search_content', { query: 'foo' })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
      if (result.status === ToolCallResponseStatus.Error) {
        expect(result.error).toContain('no index')
      }
    })
  })

  describe('callTool', () => {
    it('returns error for unknown tool name', async () => {
      const vt = new VaultTools(makeApp(), jest.fn())
      const result = await vt.callTool('vault_unknown', {})
      expect(result.status).toBe(ToolCallResponseStatus.Error)
    })
  })
})
