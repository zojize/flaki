import { Buffer } from 'node:buffer'
import * as z from 'zod'
import { octokit } from '../clients'
import { defineAiFunction } from '../utils/defineAiFunction'

export function createExploreFunctions(repoFullName: string) {
  const repoCache: Record<`file:${string}`, string> & Record<`dir:${string}`, string[]> = {}
  const [owner, repo] = repoFullName.split('/')

  if (!owner || !repo) {
    throw new Error(`Invalid repository name format: ${repoFullName}. Expected 'owner/repo'`)
  }

  const readFile = defineAiFunction({
    name: 'readFile',
    description: 'Read the content of a file from the GitHub repository using a path relative to the repository root.',
    parameters: z.object({
      path: z.string().describe('The path to the file relative to the repository root (e.g., "package.json", "src/main.ts").'),
    }),
    response: z.string(),
    implementation: async (args) => {
      const { path } = args
      const cacheKey = `file:${repoFullName}:${path}` as const

      // Check cache first
      const cached = repoCache[cacheKey]
      if (cached !== undefined) {
        return cached
      }

      try {
        const response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path,
        })

        // GitHub API returns different formats for files vs directories
        if (Array.isArray(response.data)) {
          throw new TypeError(`${path} is a directory, not a file`)
        }

        if ('content' in response.data && response.data.type === 'file') {
          // Decode base64 content
          const content = Buffer.from(response.data.content, 'base64').toString('utf-8')
          repoCache[cacheKey] = content
          return content
        }

        throw new Error(`Unable to read file: ${path}`)
      }
      catch (error: any) {
        if (error.status === 404) {
          throw new Error(`File not found: ${path}`)
        }
        throw new Error(`Failed to read file ${path}: ${error.message}`)
      }
    },
  })

  const listDir = defineAiFunction({
    name: 'listDir',
    description: 'List the contents of a directory in the GitHub repository using a path relative to the repository root.',
    parameters: z.object({
      path: z.string().describe('The path to the directory relative to the repository root (e.g., ".", "src", "test"). Use "." for repository root.'),
    }),
    response: z.array(z.string()),
    implementation: async (args) => {
      const { path } = args
      const cacheKey = `dir:${repoFullName}:${path}` as const

      // Check cache first
      const cached = repoCache[cacheKey]
      if (cached != null) {
        return cached
      }

      try {
        const response = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: path === '.' ? '' : path,
        })

        if (Array.isArray(response.data)) {
          const contents = response.data.map(item => item.name)
          repoCache[cacheKey] = contents
          return contents
        }
        else {
          throw new TypeError(`${path} is a file, not a directory`)
        }
      }
      catch (error: any) {
        if (error.status === 404) {
          throw new Error(`Directory not found: ${path}`)
        }
        throw new Error(`Failed to list directory ${path}: ${error.message}`)
      }
    },
  })

  return { readFile, listDir }
}
