import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export class TmpDirManager {
  private dirs: Set<string> = new Set()

  constructor() {
    process.on('exit', () => this.cleanup())
    process.on('SIGINT', () => this.cleanup())
    process.on('SIGTERM', () => this.cleanup())
    process.on('uncaughtException', () => this.cleanup())
  }

  async create(prefix: string = 'docker-build'): Promise<string> {
    const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`)
    await mkdir(dir, { recursive: true })
    this.dirs.add(dir)
    return dir
  }

  async cleanup(): Promise<void> {
    await Promise.all(Array.from(this.dirs).map((dir) => {
      console.log(`Cleaning up temporary directory: ${dir}`)
      return rm(dir, { recursive: true, force: true })
    }))
    this.dirs.clear()
  }
}
