import { App, TFile, TFolder } from 'obsidian'

import { RAGEngine } from '../rag/ragEngine'
import { RequestTool } from '../../types/llm/request'
import {
  ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { readTFileContent } from '../../utils/obsidian'

type VaultToolName =
  | 'vault_read_file'
  | 'vault_list_directory'
  | 'vault_search_files'
  | 'vault_search_content'

const VAULT_TOOL_NAMES: ReadonlySet<string> = new Set<VaultToolName>([
  'vault_read_file',
  'vault_list_directory',
  'vault_search_files',
  'vault_search_content',
])

export class VaultTools {
  constructor(
    private readonly app: App,
    private readonly getRagEngine: () => Promise<RAGEngine>,
  ) {}

  isNativeTool(name: string): boolean {
    return VAULT_TOOL_NAMES.has(name)
  }

  listTools(): RequestTool[] {
    return [
      {
        type: 'function',
        function: {
          name: 'vault_read_file',
          description: 'Read the content of a vault file by path',
          parameters: {
            type: 'object' as const,
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file in the vault',
              },
            },
            required: ['path'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'vault_list_directory',
          description: 'List files and folders in a vault directory',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description:
                  'Path to the directory (omit for vault root)',
              },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'vault_search_files',
          description: 'Search vault files by filename or path substring',
          parameters: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query', minLength: 1 },
            },
            required: ['query'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'vault_search_content',
          description:
            'Search vault files by content using semantic search (RAG).',
          parameters: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'Search query', minLength: 1 },
            },
            required: ['query'],
          },
        },
      },
    ]
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResponse> {
    try {
      switch (name as VaultToolName) {
        case 'vault_read_file':
          return await this.readFile(args.path as string)
        case 'vault_list_directory':
          return await this.listDirectory(args.path as string | undefined)
        case 'vault_search_files':
          return this.searchFiles(args.query as string)
        case 'vault_search_content':
          return await this.searchContent(args.query as string)
        default:
          return {
            status: ToolCallResponseStatus.Error,
            error: `Unknown vault tool: ${name}`,
          }
      }
    } catch (error) {
      return {
        status: ToolCallResponseStatus.Error,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async readFile(path: string): Promise<ToolCallResponse> {
    const file = this.app.vault.getAbstractFileByPath(path)
    if (!(file instanceof TFile)) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `File not found: ${path}`,
      }
    }
    const content = await readTFileContent(file, this.app.vault)
    return {
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: content },
    }
  }

  private async listDirectory(path?: string): Promise<ToolCallResponse> {
    const folder =
      !path || path === '/'
        ? this.app.vault.getRoot()
        : this.app.vault.getAbstractFileByPath(path)
    if (!(folder instanceof TFolder)) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `Not a directory: ${path}`,
      }
    }
    const entries = folder.children.map((child) => ({
      name: child.name,
      type: child instanceof TFolder ? 'folder' : 'file',
      path: child.path,
    }))
    return {
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: JSON.stringify(entries) },
    }
  }

  private searchFiles(query: string): ToolCallResponse {
    if (!query) {
      return {
        status: ToolCallResponseStatus.Error,
        error: 'query must not be empty',
      }
    }
    const MAX_RESULTS = 50
    const needle = query.toLowerCase()
    const all = this.app.vault
      .getFiles()
      .filter(
        (f) =>
          f.path.toLowerCase().includes(needle) ||
          f.name.toLowerCase().includes(needle),
      )
    const matches = all.slice(0, MAX_RESULTS).map((f) => f.path)
    const truncatedNote =
      all.length > MAX_RESULTS
        ? `\n... (${all.length - MAX_RESULTS} more results truncated)`
        : ''
    return {
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: matches.join('\n') + truncatedNote },
    }
  }

  private async searchContent(query: string): Promise<ToolCallResponse> {
    try {
      const ragEngine = await this.getRagEngine()
      const results = await ragEngine.processQuery({ query })
      const mapped = results.map(({ path, content, similarity, metadata }) => ({
        path,
        content,
        similarity,
        startLine: metadata?.startLine,
        endLine: metadata?.endLine,
      }))
      return {
        status: ToolCallResponseStatus.Success,
        data: { type: 'text', text: JSON.stringify(mapped) },
      }
    } catch (error) {
      return {
        status: ToolCallResponseStatus.Error,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
