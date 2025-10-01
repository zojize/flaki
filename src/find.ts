import type { FindResult, GraphQLIssueResponse, Repo } from './types'
import * as fs from 'node:fs'
import { setTimeout } from 'node:timers/promises'

import { octokit } from './clients'
import { getLogger } from './logger'

// ---- Fetch repos (with cache) ----
async function fetchRepos(repoQuery: string, repoPages: number, repoPerPage: number, cacheFile: string | undefined, verbose = false): Promise<Repo[]> {
  const logger = getLogger()

  if (cacheFile && fs.existsSync(cacheFile)) {
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))
    if (cache.query === repoQuery && cache.pages >= repoPages && cache.perPage === repoPerPage) {
      if (verbose)
        logger.info(`Using cached repos for query: ${repoQuery}`)
      return cache.repos
    }
  }

  if (verbose)
    logger.info(`Fetching repos with query: ${repoQuery}, pages: ${repoPages}, per page: ${repoPerPage}`)
  const repos: Repo[] = []
  for (let page = 1; page <= repoPages; page++) {
    if (verbose)
      logger.info(`Fetching repo page ${page}/${repoPages}...`)
    const data = await octokit.rest.search.repos({
      q: repoQuery,
      sort: 'stars',
      order: 'desc',
      per_page: repoPerPage,
      page,
    })
    repos.push(...data.data.items)
    await setTimeout(1000)
  }

  if (cacheFile) {
    fs.writeFileSync(cacheFile, JSON.stringify({ query: repoQuery, pages: repoPages, perPage: repoPerPage, repos }))
  }
  if (verbose)
    logger.info(`Fetched ${repos.length} repos`)
  return repos
}

async function fetchIssues(repos: Repo[], cutoff: string, issuePages: number, issuePerPage: number, verbose = false): Promise<FindResult[]> {
  const logger = getLogger()
  const results: FindResult[] = []
  const seen = new Set<string>()

  const query = `
    query($searchQuery: String!, $first: Int!, $after: String) {
      search(query: $searchQuery, type: ISSUE, first: $first, after: $after) {
        edges {
          node {
            ... on Issue {
              title
              url
              createdAt
              comments {
                totalCount
              }
              reactions {
                totalCount
              }
            }
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  `

  if (verbose)
    logger.info(`Processing ${repos.length} repos for issues...`)
  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i]
    if (verbose)
      logger.info(`[${i + 1}/${repos.length}] Processing repo: ${repo.full_name}`)
    const fullName = repo.full_name
    const stars = repo.stargazers_count
    const searchQuery = `repo:${fullName} ("flaky" OR "flakey" OR "intermittent") created:>${cutoff} is:issue is:open`
    let after: string | null = null
    for (let page = 1; page <= issuePages; page++) {
      if (verbose)
        logger.info(`  Fetching issues page ${page} for ${fullName}...`)
      const variables: { searchQuery: string, first: number, after: string | null } = {
        searchQuery,
        first: issuePerPage,
        after,
      }
      const data = await octokit.graphql<GraphQLIssueResponse>(query, variables)
      const edges = data.search.edges
      if (verbose)
        logger.info(`  Found ${edges.length} issues on this page`)
      for (const edge of edges) {
        const issue = edge.node
        const entry: FindResult = {
          title: issue.title,
          url: issue.url,
          repo: fullName,
          stars,
          comments: issue.comments.totalCount,
          reactions: issue.reactions.totalCount,
          created: issue.createdAt.slice(0, 10),
        }
        if (!seen.has(entry.url)) {
          results.push(entry)
          seen.add(entry.url)
        }
      }
      if (!data.search.pageInfo.hasNextPage)
        break
      after = data.search.pageInfo.endCursor
      await setTimeout(1000) // throttle
    }
  }
  if (verbose)
    console.log(`Total issues collected: ${results.length}`)
  return results
}

// ---- Output results ----
function outputResults(results: FindResult[]): void {
  if (!results.length) {
    console.log('No issues found.')
    return
  }

  // Weighted sorting: newer + more stars
  results.sort((a, b) => {
    const daysOldA = (Date.now() - new Date(a.created).getTime()) / (1000 * 60 * 60 * 24)
    const daysOldB = (Date.now() - new Date(b.created).getTime()) / (1000 * 60 * 60 * 24)
    return (b.stars - daysOldB) - (a.stars - daysOldA)
  })

  // Analysis
  const counts: Record<string, number> = {}
  for (const issue of results) {
    counts[issue.repo] = (counts[issue.repo] || 0) + 1
  }
  console.log('\n## Analysis: Repos with most flaky test issues')
  Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .forEach(([repo, count]) => {
      console.log(`- ${repo}: ${count} issues`)
    })
}

export async function runFindAgent(
  repoQuery: string,
  months: number,
  repoPages: number,
  repoPerPage: number,
  issuePages: number,
  issuePerPage: number,
  outputFile?: string,
  cacheFile?: string,
  verbose = false,
): Promise<void> {
  const logger = getLogger()
  const cutoff = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const repos = await fetchRepos(repoQuery, repoPages, repoPerPage, cacheFile, verbose)
  const results = await fetchIssues(repos, cutoff, issuePages, issuePerPage, verbose)

  const resultStr = JSON.stringify(results, null, 2)
  if (outputFile) {
    fs.writeFileSync(outputFile, resultStr)
    if (verbose)
      logger.info(`Results saved to ${outputFile}`)
  }
  else {
    console.log(resultStr)
  }

  outputResults(results)
}
