import process from 'node:process'
import winston from 'winston'

export interface LoggerOptions {
  verbose?: boolean
  outputStream?: NodeJS.WritableStream
}

let logger: winston.Logger | null = null

export function createLogger(options: LoggerOptions = {}) {
  const { verbose = false, outputStream = process.stderr } = options

  logger = winston.createLogger({
    level: verbose ? 'debug' : 'info',
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.printf(({ level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : ''
        return `${message}${metaStr}`
      }),
    ),
    transports: [
      new winston.transports.Stream({
        stream: outputStream,
        level: verbose ? 'debug' : 'info',
      }),
    ],
  })

  return logger
}

export function getLogger(): winston.Logger {
  if (!logger) {
    logger = createLogger()
  }
  return logger
}
