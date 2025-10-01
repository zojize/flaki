import { Buffer } from 'node:buffer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { octokit } from '../src/clients'
import { createExploreFunctions } from '../src/tools/explore'

// Mock the octokit client
vi.mock('../src/clients', () => ({
  octokit: {
    rest: {
      repos: {
        getContent: vi.fn(),
      },
    },
  },
}))

describe('explore tools', () => {
  const mockRepo = 'test-owner/test-repo'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createExploreFunctions', () => {
    it('should throw error for invalid repo name format', () => {
      expect(() => createExploreFunctions('invalid-repo')).toThrow('Invalid repository name format: invalid-repo. Expected \'owner/repo\'')
      expect(() => createExploreFunctions('owner')).toThrow('Invalid repository name format: owner. Expected \'owner/repo\'')
      expect(() => createExploreFunctions('')).toThrow('Invalid repository name format: . Expected \'owner/repo\'')
    })

    it('should create functions for valid repo name', () => {
      const { readFile, listDir } = createExploreFunctions(mockRepo)
      expect(readFile).toBeDefined()
      expect(listDir).toBeDefined()
    })
  })

  describe('readFile', () => {
    it('should read and decode a file content', async () => {
      const { readFile } = createExploreFunctions(mockRepo)
      const mockContent = 'Hello, World!'
      const encodedContent = Buffer.from(mockContent).toString('base64')

      vi.mocked(octokit.rest.repos.getContent)
        .mockResolvedValue({
          data: {
            type: 'file',
            content: encodedContent,
          },
        } as any)

      const result = await readFile.implementation({ path: 'README.md' })

      expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        path: 'README.md',
      })
      expect(result).toBe(mockContent)
    })

    it('should cache file content', async () => {
      const { readFile } = createExploreFunctions(mockRepo)
      const mockContent = 'Cached content'
      const encodedContent = Buffer.from(mockContent).toString('base64')

      vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
        data: {
          type: 'file',
          content: encodedContent,
        },
      } as any)

      // First call should hit the API
      await readFile.implementation({ path: 'package.json' })
      expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1)

      // Second call should use cache
      await readFile.implementation({ path: 'package.json' })
      expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1) // Still 1 call
    })

    it('should throw error for directory path', async () => {
      const { readFile } = createExploreFunctions(mockRepo)

      vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
        data: [
          { name: 'file1.txt', type: 'file' },
          { name: 'file2.txt', type: 'file' },
        ],
      } as any)

      await expect(readFile.implementation({ path: 'src' })).rejects.toThrow('src is a directory, not a file')
    })

    it('should throw error for 404 file not found', async () => {
      const { readFile } = createExploreFunctions(mockRepo)

      const error = new Error('Not Found') as any
      error.status = 404
      vi.mocked(octokit.rest.repos.getContent).mockRejectedValue(error)

      await expect(readFile.implementation({ path: 'nonexistent.md' })).rejects.toThrow('File not found: nonexistent.md')
    })

    it('should throw error for other API failures', async () => {
      const { readFile } = createExploreFunctions(mockRepo)

      const error = new Error('Internal Server Error') as any
      error.status = 500
      vi.mocked(octokit.rest.repos.getContent).mockRejectedValue(error)

      await expect(readFile.implementation({ path: 'test.md' })).rejects.toThrow('Failed to read file test.md: Internal Server Error')
    })
  })

  describe('listDir', () => {
    it('should list directory contents', async () => {
      const { listDir } = createExploreFunctions(mockRepo)
      const mockFiles = [
        { name: 'file1.txt', type: 'file' },
        { name: 'file2.js', type: 'file' },
        { name: 'subdir', type: 'dir' },
      ]

      vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
        data: mockFiles,
      } as any)

      const result = await listDir.implementation({ path: 'src' })

      expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        path: 'src',
      })
      expect(result).toEqual(['file1.txt', 'file2.js', 'subdir'])
    })

    it('should handle root directory (empty path)', async () => {
      const { listDir } = createExploreFunctions(mockRepo)
      const mockFiles = [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'dir' },
        { name: 'package.json', type: 'file' },
      ]

      vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
        data: mockFiles,
      } as any)

      const result = await listDir.implementation({ path: '.' })

      expect(octokit.rest.repos.getContent).toHaveBeenCalledWith({
        owner: 'test-owner',
        repo: 'test-repo',
        path: '',
      })
      expect(result).toEqual(['README.md', 'src', 'package.json'])
    })

    it('should cache directory contents', async () => {
      const { listDir } = createExploreFunctions(mockRepo)
      const mockFiles = [
        { name: 'index.js', type: 'file' },
        { name: 'utils.js', type: 'file' },
      ]

      vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
        data: mockFiles,
      } as any)

      // First call should hit the API
      await listDir.implementation({ path: 'lib' })
      expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1)

      // Second call should use cache
      await listDir.implementation({ path: 'lib' })
      expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(1) // Still 1 call
    })

    it('should throw error for file path', async () => {
      const { listDir } = createExploreFunctions(mockRepo)

      vi.mocked(octokit.rest.repos.getContent).mockResolvedValue({
        data: {
          type: 'file',
          content: 'SGVsbG8gV29ybGQ=', // "Hello World" in base64
        },
      } as any)

      await expect(listDir.implementation({ path: 'README.md' })).rejects.toThrow('README.md is a file, not a directory')
    })

    it('should throw error for 404 directory not found', async () => {
      const { listDir } = createExploreFunctions(mockRepo)

      const error = new Error('Not Found') as any
      error.status = 404
      vi.mocked(octokit.rest.repos.getContent).mockRejectedValue(error)

      await expect(listDir.implementation({ path: 'nonexistent' })).rejects.toThrow('Directory not found: nonexistent')
    })

    it('should throw error for other API failures', async () => {
      const { listDir } = createExploreFunctions(mockRepo)

      const error = new Error('Forbidden') as any
      error.status = 403
      vi.mocked(octokit.rest.repos.getContent).mockRejectedValue(error)

      await expect(listDir.implementation({ path: 'private' })).rejects.toThrow('Failed to list directory private: Forbidden')
    })
  })

  describe('caching behavior', () => {
    it('should maintain separate caches for different repositories', async () => {
      const { readFile: readFile1 } = createExploreFunctions('repo1/owner1')
      const { readFile: readFile2 } = createExploreFunctions('repo2/owner2')

      const content1 = 'Content from repo1'
      const content2 = 'Content from repo2'

      vi.mocked(octokit.rest.repos.getContent)
        .mockResolvedValueOnce({
          data: { type: 'file', content: Buffer.from(content1).toString('base64') },
        } as any)
        .mockResolvedValueOnce({
          data: { type: 'file', content: Buffer.from(content2).toString('base64') },
        } as any)

      // Read same file path from different repos
      const result1 = await readFile1.implementation({ path: 'shared.txt' })
      const result2 = await readFile2.implementation({ path: 'shared.txt' })

      expect(result1).toBe(content1)
      expect(result2).toBe(content2)
      expect(octokit.rest.repos.getContent).toHaveBeenCalledTimes(2)
    })
  })
})
