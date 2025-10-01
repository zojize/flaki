import type { ContentListUnion, FunctionDeclaration } from '@google/genai'
import type { FilteredResult } from '../types'
import fs from 'node:fs'
import process, { stdin } from 'node:process'
import { text } from 'node:stream/consumers'
import z from 'zod'
import { genAI } from '../clients'
import { getLogger } from '../logger'
import { createDockerFunctions } from '../tools/docker'
import { createExploreFunctions } from '../tools/explore'
import { FilteredResultSchema } from '../types'
import { defineAiFunction, runAiFunction } from '../utils/defineAiFunction'

const reproductionResultSchema = z.object({
  status: z.enum(['success', 'failure']).describe('The status of the reproduction attempt.'),
  reason: z.string().describe('A detailed explanation of the findings, including steps taken, observations, and any relevant logs or error messages.'),
  dockerFile: z.string().optional().describe('The content of the Dockerfile used for the reproduction, if applicable.'),
  reproductionSteps: z.string().array().optional().describe('A list of commands that reliably reproduce the flaky test behavior.'),
})

type ReproductionResult = z.infer<typeof reproductionResultSchema>

const report = defineAiFunction({
  name: 'report',
  description: 'Report the status and findings of the reproduction attempt, you should NOT call this function until you have concluded that the reproduction process have succeeded or failed. The reason field should include a detailed explanation of the findings, including steps taken, observations, and any relevant logs or error messages. If you were able to create a Dockerfile that reliably reproduces the flaky test behavior, include it in the dockerFile field. If you have identified specific commands that can reproduce the flaky behavior, list them in the reproductionSteps field. If the reproduction was unsuccessful, clearly state the reasons and any obstacles encountered.',
  parameters: reproductionResultSchema,
  implementation: () => {
    /* dummy implementation */
  },
})

export async function runReproducerAgent(inputFile?: string, maxIterations: number = 50, outputFile?: string, force: boolean = false): Promise<void> {
  const logger = getLogger()
  // Read and validate input data
  let rawData: string
  if (inputFile) {
    rawData = fs.readFileSync(inputFile, 'utf-8')
  }
  else {
    rawData = await text(stdin)
  }

  const parsedData = JSON.parse(rawData)

  // Handle both single FilteredResult and array of FilteredResult
  const filteredResults: FilteredResult[] = Array.isArray(parsedData) ? parsedData : [parsedData]

  const finalOutput: {
    issue: FilteredResult
    maxIterations: number
    reproductionResult: ReproductionResult | null
    functionCallHistory: { name: string, args: any, result: any, key: 'error' | 'output' }[]
    agentResponses: { iteration: number, text: string }[]
  }[] = []

  // Validate each result using the schema
  for (const result of filteredResults) {
    const validation = FilteredResultSchema.safeParse(result)
    if (!validation.success) {
      throw new Error(`Invalid FilteredResult: ${validation.error.message}`)
    }
  }

  // Process each issue one by one
  for (let i = 0; i < filteredResults.length; i++) {
    const result = filteredResults[i]

    // Skip issues that were determined not to be flaky tests unless force is enabled
    if (!result.isFlakyTestIssue && !force) {
      logger.info(`⏭️  Skipping issue ${i + 1}/${filteredResults.length}: ${result.title} (not determined to be a flaky test)`)
      continue
    }

    if (filteredResults.length > 1) {
      logger.info(`\n🔄 Processing issue ${i + 1}/${filteredResults.length}: ${result.title}`)
    }

    const { finalResult, functionCallHistory, agentResponses } = await reproduceWithGemini(result, maxIterations)

    const output = {
      issue: result,
      maxIterations,
      reproductionResult: finalResult,
      functionCallHistory,
      agentResponses,
    }
    finalOutput.push(output)
  }

  // Output the result as JSON
  const outputStream = outputFile ? fs.createWriteStream(outputFile) : process.stdout

  outputStream.write(JSON.stringify(finalOutput, null, 2))
  if (outputFile) {
    outputStream.end()
    logger.info(`\n✅ Reproduction results saved to ${outputFile}`)
  }
  else {
    outputStream.write('\n')
  }
}

export async function reproduceWithGemini(filteredResult: FilteredResult, maxIterations: number = 50): Promise<{
  finalResult: {
    status: 'success' | 'failure'
    reason: string
    dockerFile?: string
    reproductionSteps?: string[]
  } | null
  functionCallHistory: { name: string, args: any, result: any, key: 'error' | 'output' }[]
  agentResponses: { iteration: number, text: string }[]
}> {
  const logger = getLogger()
  const { listDir, readFile } = createExploreFunctions(filteredResult.repo)
  const { buildImage, createContainer, executeCommand } = createDockerFunctions(filteredResult.repo)
  const aiFunctions = [readFile, listDir, buildImage, createContainer, executeCommand, report]
  const aiFunctionsMap = Object.fromEntries(aiFunctions.map(f => [f.declaration.name, f]))
  const functionDeclarations: FunctionDeclaration[] = aiFunctions.map(f => f.declaration)

  const systemInstruction = `# Flaky Test Reproducer Agent

## Your Role
You are an expert DevOps engineer and test automation specialist tasked with reproducing flaky test failures in software projects. Your goal is to create a reliable reproduction environment that can consistently trigger the flaky behavior described in GitHub issues.

## Task Overview
Given a GitHub issue about flaky tests, you need to:
1. **Analyze the issue** to understand the test environment and failure patterns
2. **Explore the repository** to understand the project structure and build system
3. **Create a Docker environment** that matches the issue's requirements
4. **Execute tests** to reproduce the flaky behavior
5. **Document findings** for developers to fix the root cause

## Available Tools
- **readFile**: Read repository files to understand build configuration, test setup, and dependencies
- **listDir**: Explore directory structure to understand project layout
- **buildImage**: Create Docker images with proper Node.js/Python/Java environments
- **createContainer**: Set up containers with the repository already cloned and ready for testing
- **executeCommand**: Run build commands, test suites, and debugging operations
- **report**: Finalize the reproduction attempt with status, findings, and reproduction details (call this only when reproduction is complete)

## Step-by-Step Process
Follow this systematic approach:

### Phase 1: Repository Analysis
1. **Identify build system**: Look for package.json, requirements.txt, pom.xml, build.gradle, etc.
2. **Check test configuration**: Find test scripts, CI configuration (.github/workflows, .travis.yml, etc.)
3. **Understand dependencies**: Review package versions, runtime requirements
4. **Analyze test structure**: Look at test directories, test naming patterns, test runners

### Phase 2: Environment Setup
1. **Choose base image**: Select appropriate Node.js/Python/Java version based on project requirements
2. **Repository access**: The repository is already cloned and available in the Docker build context via the buildImage function
3. **Create container**: Start a container from the built image
4. **Install dependencies**: Run package manager commands (npm install, pip install, etc.)
5. **Configure environment**: Set environment variables, working directories

### Phase 3: Test Execution
1. **Build the project**: Run build commands (npm install, pip install, mvn compile, etc.)
2. **Run tests**: Execute the specific test or test suite mentioned in the issue
3. **Observe behavior**: Look for the flaky patterns described (timing issues, race conditions, etc.)
4. **Document reproduction**: Note exact steps that trigger the flaky behavior

### Phase 4: Final Report
When you have successfully reproduced the flaky behavior OR determined that reproduction is not possible:
- Use the **report** tool to document your findings
- Include detailed reproduction steps if successful
- Provide the Dockerfile content if you created a reliable reproduction environment
- Clearly explain any obstacles or reasons for failure

## Iteration Tracking
- **Current iteration**: You have {remainingIterations} iterations remaining out of {maxIterations} total
- **Final iteration requirement**: On your final iteration, you MUST call the report function to conclude the reproduction attempt, even if you haven't fully succeeded. Do not continue exploring indefinitely.`
  let repoStructure = '## Repository Structure\n\n'

  try {
    // Get root directory listing
    const rootContents = await listDir.implementation({ path: '.' })
    repoStructure += `Root directory contents:\n\`\`\`json\n${JSON.stringify(rootContents, null, 2)}\n\`\`\`\n\n`
  }
  catch (error) {
    repoStructure += `Error exploring repository: ${error}\n\n`
  }

  const initialPrompt = `## Issue Details
**Title**: ${filteredResult.title}
**Summary**: ${filteredResult.summary || 'No summary available'}
**Environment**: ${JSON.stringify(filteredResult.environment || {}, null, 2)}
**Reasoning**: ${filteredResult.reasoning}

${repoStructure}

## Instructions
Start by exploring the repository structure. Use readFile and listDir to understand the project setup. Focus on:
- Build configuration files (package.json, requirements.txt, etc.)
- Test directories and files
- CI/CD configuration (.github/workflows, etc.)
- Dependency management files

Once you understand the project, create a Docker-based reproduction environment:
1. Use buildImage to create a Docker image - the repository is already cloned and available in the build context
2. Create a container from this image
3. Install dependencies and run the build/test commands
4. Attempt to reproduce the flaky test behavior described in the issue

The buildImage function provides the GitHub repository already cloned and ready in the Docker build context. You do not need to manually clone the repository or use COPY commands in your Dockerfile.

Begin by telling me what files you want to examine first.`

  const contents: ContentListUnion = [{ role: 'user', parts: [{ text: initialPrompt }] }]

  const functionCallHistory: { name: string, args: any, result: any, key: 'error' | 'output' }[] = []
  const agentResponses: { iteration: number, text: string }[] = []
  let finalResult: {
    status: 'success' | 'failure'
    reason: string
    dockerFile?: string
    reproductionSteps?: string[]
  } | null = null

  for (let i = 0; i < maxIterations; i++) {
    const remainingIterations = maxIterations - i - 1

    // Update system instruction with current iteration info
    const currentSystemInstruction = systemInstruction.replace('{remainingIterations}', remainingIterations.toString()).replace('{maxIterations}', maxIterations.toString())

    const response = await genAI.models.generateContent({
      model: 'gemini-2.5-pro',
      contents,
      config: {
        tools: [{ functionDeclarations }],
        systemInstruction: currentSystemInstruction,
      },
    })

    if (response.text) {
      logger.debug(`💬 Agent response (iteration ${i + 1}): ${response.text}`)
      agentResponses.push({ iteration: i + 1, text: response.text })
    }

    const functionCalls = response.functionCalls || []
    if (functionCalls.length === 0) {
      logger.debug('Agent responded without making a function call:', response.text)
      break
    }

    for (const call of functionCalls) {
      const { name, args } = call

      logger.debug(`🔧 Agent calling tool: ${name} with args:`, args)
      let key: 'error' | 'output' = 'output'
      let result: any
      try {
        if (!name)
          throw new Error(`Function call missing name`)
        result = await runAiFunction(aiFunctionsMap, name, args)
        logger.debug(`✅ Tool ${name} completed successfully`)
      }
      catch (error) {
        key = 'error'
        result = `Error: ${(error as Error).message}`
        logger.debug(`❌ Tool ${name} failed: ${(error as Error).message}`)
      }
      finally {
        functionCallHistory.push({ name: name || 'unknown', args, result, key })
      }

      // Check if this is a report call
      if (name === 'report') {
        finalResult = args as {
          status: 'success' | 'failure'
          reason: string
          dockerFile?: string
          reproductionSteps?: string[]
        }
        logger.debug(`Report called with status: ${finalResult.status}`)
        // End the loop when report is called
        return { finalResult, functionCallHistory, agentResponses }
      }

      contents.push(
        { role: 'model', parts: [{ functionCall: { name, args } }] },
        { role: 'user', parts: [{ functionResponse: { name, response: { [key]: result } } }] },
      )
    }
  }

  logger.warn('Reproducer agent exceeded max iterations without reporting a final result.')

  return { finalResult, functionCallHistory, agentResponses }
}
