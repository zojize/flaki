import type { DetailedIssue, FilteredResult, FiltererResult, FindResult } from '../types'
import fs from 'node:fs'
import process from 'node:process'
import { text } from 'node:stream/consumers'
import { setTimeout } from 'node:timers/promises'
import * as z from 'zod'
import { genAI, octokit } from '../clients'
import { getLogger } from '../logger'
import { createExploreFunctions } from '../tools/explore'
import { defineAiFunction, runAiFunction } from '../utils/defineAiFunction'

const analyzeIssue = defineAiFunction({
  name: 'analyzeIssue',
  description: 'Analyze the GitHub issue to determine if it describes a genuine flaky test problem. Provide a structured assessment with confidence level and detailed reasoning.',
  parameters: z.object({
    isFlakyTestIssue: z.boolean().describe('True only if this is a genuine flaky test problem requiring engineering attention'),
    confidence: z.number().min(0).max(100).describe('Statistical confidence in the assessment (0-100)'),
    summary: z.string().optional().describe('Concise technical summary for developers (only if it is a flaky test issue)'),
    reasoning: z.string().describe('Detailed explanation of the evaluation process and evidence'),
    environment: z.object({
      language: z.string().optional().describe('Programming language mentioned'),
      framework: z.string().optional().describe('Test framework used'),
      ci: z.string().optional().describe('CI/CD system mentioned'),
      os: z.string().optional().describe('Operating system mentioned'),
    }).optional().describe('Extracted technical environment details'),
  }),
  implementation: () => {
    /* dummy implementation */
  },
})

// ---- Fetch detailed issue data ----
async function fetchDetailedIssue({ url, stars }: FindResult): Promise<DetailedIssue | null> {
  try {
    // Extract owner, repo, and issue number from URL
    const urlMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
    if (!urlMatch) {
      console.error(`Invalid GitHub issue URL: ${url}`)
      return null
    }

    const [, owner, repo, issueNumber] = urlMatch

    // Fetch issue details
    const issueResponse = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: +issueNumber,
    })

    const issue = issueResponse.data

    // Fetch comments
    const commentsResponse = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: +issueNumber,
      per_page: 100,
    })

    // Fetch linked PRs (if any mentioned in the issue)
    const linkedPRs: { title: string, url: string, merged: boolean }[] = []

    // Check for PR references in body and comments
    const prReferences = new Set<string>()
    if (issue.body) {
      const prMatches = issue.body.match(/#(\d+)/g) || []
      prMatches.forEach(match => prReferences.add(match.slice(1)))
    }

    commentsResponse.data.forEach((comment) => {
      if (comment.body) {
        const prMatches = comment.body.match(/#(\d+)/g) || []
        prMatches.forEach(match => prReferences.add(match.slice(1)))
      }
    })

    // Fetch PR details for referenced numbers
    for (const prNumber of prReferences) {
      try {
        const prResponse = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: Number.parseInt(prNumber, 10),
        })
        linkedPRs.push({
          title: prResponse.data.title,
          url: prResponse.data.html_url,
          merged: prResponse.data.merged || false,
        })
      }
      catch {
        // PR might not exist or be inaccessible, skip
      }
    }

    return {
      title: issue.title,
      url: issue.html_url,
      repo: `${owner}/${repo}`,
      stars,
      comments: issue.comments,
      reactions: issue.reactions?.total_count || 0,
      created: issue.created_at,
      body: issue.body || undefined,
      commentsList: commentsResponse.data.map(comment => ({
        body: comment.body || '',
        author: comment.user?.login || 'unknown',
        createdAt: comment.created_at,
      })),
      linkedPRs,
    }
  }
  catch (error) {
    console.error(`Failed to fetch detailed issue data for ${url}:`, error)
    return null
  }
}

// ---- Analyze issue with Gemini ----
async function analyzeIssueWithGemini(detailedIssue: DetailedIssue): Promise<FiltererResult> {
  const logger = getLogger()
  // Extract repo information for explore tools
  const repoMatch = detailedIssue.url.match(/github\.com\/([^/]+)\/([^/]+)\/issues/)
  if (!repoMatch) {
    throw new Error(`Invalid GitHub URL: ${detailedIssue.url}`)
  }
  const [, owner, repo] = repoMatch
  const repoName = `${owner}/${repo}`

  // Create explore functions for this repository
  const { listDir, readFile } = createExploreFunctions(repoName)

  // AI functions available to the agent
  const aiFunctions = [readFile, listDir, analyzeIssue]
  const aiFunctionsMap = Object.fromEntries(aiFunctions.map(f => [f.declaration.name, f]))
  const functionDeclarations = aiFunctions.map(f => f.declaration)

  const systemInstruction = `# Flaky Test Issue Analysis Agent

## Your Role
You are a senior software engineer and QA automation expert with 10+ years of experience debugging test infrastructure, CI/CD pipelines, and complex distributed systems. Your specialty is distinguishing genuine flaky tests from false positives.

## Task
Analyze the provided GitHub issue to determine if it describes a **genuine flaky test problem** that requires engineering attention, versus issues that merely contain the words "flaky" or "intermittent" but are actually different problems.

## Flaky Test Definition
A flaky test is characterized by **unpredictable behavior**: the same test code passes and fails randomly under identical conditions. Common causes include:

### Technical Causes
- **Race conditions**: Tests depending on execution timing between threads/processes
- **Resource contention**: Tests competing for shared resources (files, ports, databases)
- **Network dependencies**: Tests relying on external services with variable latency
- **Async timing issues**: Tests with insufficient waits or improper async handling
- **Environment sensitivity**: Tests affected by system load, memory, or OS differences
- **Test isolation problems**: Tests interfering with each other in parallel execution

### Observable Patterns
- **Non-deterministic results**: Same commit passes/fails randomly across CI runs
- **Timing sensitivity**: Failures occur only under specific load or timing conditions
- **Local vs CI differences**: Works locally but fails in automated environments
- **Retry dependencies**: Tests pass when retried or run in isolation

## Analysis Framework
Use this systematic evaluation process:

### Step 1: Content Analysis
- Does the issue describe **unpredictable behavior** (passes/fails randomly)?
- Are there **specific failure patterns** mentioned (timing, load, environment)?
- Does it discuss **reproduction challenges** (works locally, fails in CI)?

### Step 2: Evidence Assessment
- **CI/CD evidence**: Multiple failed builds with same commit?
- **Retry patterns**: Does re-running tests resolve issues?
- **Isolation testing**: Does running test alone vs in suite change results?
- **Environment differences**: Different behavior across machines/platforms?

### Step 3: Solution Indicators
- **Workarounds mentioned**: Retries, sleeps, ordering changes, isolation fixes?
- **Root cause discussion**: Race conditions, timing issues, resource conflicts?
- **Engineering solutions**: Proper waits, locks, environment stabilization?

### Step 4: False Positive Detection
- **Misleading keywords**: Issue mentions "flaky" but is actually about:
  - Test data issues (corrupt test fixtures)
  - Code bugs (logic errors, not timing)
  - Configuration problems (environment setup)
  - Performance issues (slow tests, not random failures)

## Available Tools
- **readFile**: Read repository files to understand the project structure and test configuration
- **listDir**: Explore directory structure to understand the project layout
- **analyzeIssue**: Finalize your analysis with a structured assessment

## Important Notes
- **Conservative classification**: Only classify as flaky if evidence strongly supports unpredictable behavior
- **Technical focus**: Prioritize engineering analysis over keyword matching
- **Evidence-based**: Base assessment on described behavior patterns, not assumptions
- **Actionable insights**: Summary should help developers understand and fix the root cause`

  const initialPrompt = `## Issue Content Analysis

### Issue Title
${detailedIssue.title}

### Issue Description
${detailedIssue.body || 'No description provided'}

### Comments (${detailedIssue.commentsList?.length || 0})
${detailedIssue.commentsList?.map(comment =>
  `- **${comment.author}**: ${comment.body.slice(0, 500)}${comment.body.length > 500 ? '...' : ''}`,
).join('\n') || 'No comments'}

### Linked Pull Requests (${detailedIssue.linkedPRs?.length || 0})
${detailedIssue.linkedPRs?.map(pr =>
  `- **${pr.title}** (${pr.merged ? 'merged' : 'open'})`,
).join('\n') || 'No linked PRs'}

## Instructions
Analyze this GitHub issue to determine if it describes a genuine flaky test problem. You can use the readFile and listDir tools to explore the repository if you need more context about the project structure, test configuration, or CI setup.

Work through the evaluation checklist systematically and use the analyzeIssue tool when you have completed your assessment.

Begin by examining the issue content and determining if you need additional repository information.`

  const contents = [{ role: 'user', parts: [{ text: initialPrompt }] }] as any[]

  // Multiple interactions - allow AI to make multiple rounds of tool calls
  const maxIterations = 10
  for (let i = 0; i < maxIterations; i++) {
    const response = await genAI.models.generateContent({
      model: 'gemini-2.5-pro',
      contents,
      config: {
        tools: [{ functionDeclarations }],
        systemInstruction,
      },
    })

    const functionCalls = response.functionCalls || []
    if (functionCalls.length === 0) {
      logger.debug('Agent responded without making a function call:', response.text)
      break
    }

    // Process function calls until analyzeIssue is called
    for (const call of functionCalls) {
      const { name, args } = call

      if (name === 'analyzeIssue') {
        // This is the final result
        const resultArgs = args as {
          isFlakyTestIssue: boolean
          confidence: number
          summary?: string
          reasoning: string
          environment?: {
            language?: string
            framework?: string
            ci?: string
            os?: string
          }
        }
        return {
          isFlakyTestIssue: resultArgs.isFlakyTestIssue,
          confidence: resultArgs.confidence,
          summary: resultArgs.summary,
          reasoning: resultArgs.reasoning,
          environment: resultArgs.environment,
        }
      }

      // Execute other tools
      logger.debug(`🔧 Agent calling tool: ${name} with args:`, args)
      let result: any
      try {
        if (!name) {
          throw new Error('Function call missing name')
        }
        result = await runAiFunction(aiFunctionsMap, name, args)
        logger.debug(`✅ Tool ${name} completed successfully`)
      }
      catch (error) {
        result = `Error: ${(error as Error).message}`
        logger.debug(`❌ Tool ${name} failed: ${(error as Error).message}`)
      }

      // Add the tool call and result to conversation
      contents.push(
        { role: 'model', parts: [{ functionCall: { name, args } }] },
        { role: 'user', parts: [{ functionResponse: { name, response: { output: result } } }] },
      )
    }
  }

  // If we get here, analyzeIssue was never called within max iterations
  throw new Error(`AI completed analysis without calling analyzeIssue after ${maxIterations} iterations`)
}

// ---- Main filter function ----
export async function filterFlakyTestIssues(results: FindResult[]): Promise<FilteredResult[]> {
  const logger = getLogger()
  const filteredResults: FilteredResult[] = []

  logger.info(`\n🔍 Starting to filter ${results.length} issues with AI analysis...`)

  for (let i = 0; i < results.length; i++) {
    const result = results[i]

    logger.info(`\n[${i + 1}/${results.length}] Analyzing: ${result.title}`)
    logger.info(`URL: ${result.url}`)

    // Fetch detailed issue data
    const detailedIssue = await fetchDetailedIssue(result)

    if (!detailedIssue) {
      logger.warn('❌ Failed to fetch detailed issue data, skipping...')
      continue
    }

    // Analyze with Gemini
    logger.info('🤖 Analyzing with Gemini AI...')

    const analysis = await analyzeIssueWithGemini(detailedIssue)

    const filteredResult: FilteredResult = {
      ...result,
      isFlakyTestIssue: analysis.isFlakyTestIssue,
      confidence: analysis.confidence,
      summary: analysis.summary,
      reasoning: analysis.reasoning,
      environment: analysis.environment,
    }

    filteredResults.push(filteredResult)

    const status = analysis.isFlakyTestIssue ? '✅' : '❌'
    logger.info(`${status} ${analysis.isFlakyTestIssue ? 'Flaky test issue' : 'Not a flaky test issue'} (${analysis.confidence}% confidence)`)
    logger.info(`Reasoning: ${analysis.reasoning}`)
    if (analysis.summary) {
      logger.info(`Summary: ${analysis.summary}`)
    }

    await setTimeout(1000)
  }

  const genuineFlakyIssues = filteredResults.filter(r => r.isFlakyTestIssue)
  logger.info(`\n📊 Filter Results:`)
  logger.info(`Total issues analyzed: ${filteredResults.length}`)
  logger.info(`Genuine flaky test issues: ${genuineFlakyIssues.length}`)
  logger.info(`False positives: ${filteredResults.length - genuineFlakyIssues.length}`)

  return filteredResults
}

// ---- CLI integration ----
export async function runFilterAgent(inputFile?: string, outputFile?: string): Promise<void> {
  const logger = getLogger()
  try {
    // Read input data
    let rawData: string
    if (inputFile) {
      rawData = fs.readFileSync(inputFile, 'utf-8')
    }
    else {
      // Read from stdin
      rawData = await text(process.stdin)
    }

    const results: FindResult[] = JSON.parse(rawData)

    if (results.length === 0) {
      logger.info('No issues to filter.')
      return
    }

    if (inputFile && outputFile) {
      logger.info(`Loaded ${results.length} issues from ${inputFile}`)
    }
    else if (!inputFile && outputFile) {
      // Only show stdin message when writing to file (not when piping)
      logger.info(`Loaded ${results.length} issues from stdin`)
    }

    const filteredResults = await filterFlakyTestIssues(results)

    // Output filtered results
    const outputData = JSON.stringify(filteredResults, null, 2)
    const outputStream = outputFile ? fs.createWriteStream(outputFile) : process.stdout

    outputStream.write(outputData)
    if (outputFile) {
      outputStream.end()
      logger.info(`\n✅ Filtered results saved to ${outputFile}`)
    }
    else {
      outputStream.write('\n')
    }

    // Display summary to stderr when outputting JSON to stdout
    // Display summary
    const genuineIssues = filteredResults.filter(r => r.isFlakyTestIssue)
    logger.info(`\n📈 Summary:`)
    logger.info(`- Total issues analyzed: ${filteredResults.length}`)
    logger.info(`- Genuine flaky test issues: ${genuineIssues.length}`)
    logger.info(`- Filtered out: ${filteredResults.length - genuineIssues.length}`)

    if (genuineIssues.length > 0) {
      logger.info(`\n🎯 Top genuine flaky test issues:`)
      genuineIssues
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5)
        .forEach((issue, index) => {
          logger.info(`${index + 1}. ${issue.title} (${issue.confidence}% confidence)`)
          logger.info(`   ${issue.url}`)
          if (issue.summary) {
            logger.info(`   Summary: ${issue.summary}`)
          }
        })
    }
  }
  catch (error) {
    logger.error('Failed to run filter agent:', error)
    process.exit(1)
  }
}
