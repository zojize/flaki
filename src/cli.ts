import process from 'node:process'
import { Command } from '@commander-js/extra-typings'
import { version } from '../package.json'
import { createLogger } from './logger'

function main(): void {
  const program = new Command()

  program
    .name('flaki')
    .description('Find and filter flaky test issues on GitHub')
    .version(version)

  program
    .command('find')
    .description('Find flaky test issues on GitHub')
    .requiredOption('--repo-query <query>', 'GitHub repo search query')
    .option('--months <num>', 'Look back this many months', (value: string) => +value, 6)
    .option('--repo-pages <num>', 'Number of repo search pages', (value: string) => +value, 1)
    .option('--repo-per-page <num>', 'Number of repos per page', (value: string) => +value, 100)
    .option('--issue-pages <num>', 'Number of issue search pages per repo', (value: string) => +value, 1)
    .option('--issue-per-page <num>', 'Number of issues per page', (value: string) => +value, 100)
    .option('--output <file>', 'Output file for results (JSON)')
    .option('--cache-file <file>', 'Cache file for repo data (JSON)')
    .option('--verbose', 'Enable verbose logging')
    .action(async (options) => {
      const { repoQuery, months, repoPages, repoPerPage, issuePages, issuePerPage, output: outputFile, cacheFile, verbose } = options
      createLogger({ verbose, outputStream: process.stderr })
      const { runFindAgent } = await import('./find')
      await runFindAgent(repoQuery, months, repoPages, repoPerPage, issuePages, issuePerPage, outputFile, cacheFile, verbose)
    })

  program
    .command('filter')
    .description('Filter issues using AI to identify genuine flaky test issues')
    .option('--input <file>', 'Input file with issues (JSON). If not provided, reads from stdin')
    .option('--output <file>', 'Output file for filtered results (JSON). If not provided, writes to stdout')
    .option('--verbose', 'Enable verbose logging')
    .action(async (options) => {
      const { input, output, verbose } = options
      createLogger({ verbose, outputStream: process.stderr })
      const { runFilterAgent } = await import('./agents/filterer')
      await runFilterAgent(input, output)
    })

  program
    .command('reproduce')
    .description('Reproduce flaky test issues using AI and Docker environments')
    .option('--input <file>', 'Input file with filtered issue(s) (JSON). If not provided, reads from stdin')
    .option('--output <file>', 'Output file for reproduction results (JSON). If not provided, writes to stdout')
    .option('--max-iterations <num>', 'Maximum number of AI iterations', (value: string) => +value, 50)
    .option('--force', 'Force reproduction of issues even if they were determined not to be flaky tests')
    .option('--verbose', 'Enable verbose logging')
    .action(async (options) => {
      const { input, output, maxIterations, force, verbose } = options
      createLogger({ verbose, outputStream: process.stderr })
      const { runReproducerAgent: processReproducerInput } = await import('./agents/reproducer')
      await processReproducerInput(input, maxIterations, output, force)
    })

  program.parse()
}

try {
  main()
}
catch (error) {
  console.error(error)
}
