import * as z from 'zod'

// Shared type definitions

export interface Repo {
  full_name: string
  stargazers_count: number
}

export const FindResultSchema = z.object({
  title: z.string(),
  url: z.string().url(),
  repo: z.string(),
  stars: z.number().min(0),
  comments: z.number().min(0),
  reactions: z.number().min(0),
  created: z.string(),
})

export type FindResult = z.infer<typeof FindResultSchema>

export interface DetailedIssue extends FindResult {
  body?: string
  commentsList?: {
    body: string
    author: string
    createdAt: string
  }[]
  linkedPRs?: {
    title: string
    url: string
    merged: boolean
  }[]
}

export const FiltererResultSchema = z.object({
  isFlakyTestIssue: z.boolean(),
  confidence: z.number().min(0).max(100),
  summary: z.string().optional(),
  reasoning: z.string(),
  environment: z.object({
    os: z.string().optional(),
    testCommand: z.string().optional(),
    additionalInfo: z.string().optional(),
  }).optional(),
})

export type FiltererResult = z.infer<typeof FiltererResultSchema>

export const FilteredResultSchema = FindResultSchema.extend(FiltererResultSchema.shape)

export type FilteredResult = z.infer<typeof FilteredResultSchema>

export interface GraphQLIssueResponse {
  search: {
    edges: {
      node: {
        title: string
        url: string
        createdAt: string
        comments: { totalCount: number }
        reactions: { totalCount: number }
      }
    }[]
    pageInfo: {
      endCursor: string | null
      hasNextPage: boolean
    }
  }
}
