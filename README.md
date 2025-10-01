# Flaki

An AI-powered flaky test detection/reproduction tool.

## Usage

```text
Usage: flaki [options] [command]

Find and filter flaky test issues on GitHub

Options:
  -V, --version        output the version number
  -h, --help           display help for command

Commands:
  find [options]       Find flaky test issues on GitHub
  filter [options]     Filter issues using AI to identify genuine flaky test issues
  reproduce [options]  Reproduce flaky test issues using AI and Docker environments
  help [command]       display help for command
```

## Commands

```text
Usage: flaki find [options]

Find flaky test issues on GitHub

Options:
  --repo-query <query>    GitHub repo search query
  --months <num>          Look back this many months (default: 6)
  --repo-pages <num>      Number of repo search pages (default: 1)
  --repo-per-page <num>   Number of repos per page (default: 100)
  --issue-pages <num>     Number of issue search pages per repo (default: 1)
  --issue-per-page <num>  Number of issues per page (default: 100)
  --output <file>         Output file for results (JSON)
  --cache-file <file>     Cache file for repo data (JSON)
  --verbose               Enable verbose logging
  -h, --help              display help for command
```

```text
Usage: flaki filter [options]

Filter issues using AI to identify genuine flaky test issues

Options:
  --input <file>   Input file with issues (JSON). If not provided, reads from stdin
  --output <file>  Output file for filtered results (JSON). If not provided, writes to stdout
  --verbose        Enable verbose logging
  -h, --help       display help for command
```

```text
Usage: flaki reproduce [options]

Reproduce flaky test issues using AI and Docker environments

Options:
  --input <file>          Input file with filtered issue(s) (JSON). If not provided, reads from stdin
  --output <file>         Output file for reproduction results (JSON). If not provided, writes to stdout
  --max-iterations <num>  Maximum number of AI iterations (default: 50)
  --force                 Force reproduction of issues even if they were determined not to be flaky tests
  --verbose               Enable verbose logging
  -h, --help              display help for command
```
