import { execSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import Docker from 'dockerode'
import * as z from 'zod'
import { createLogger } from '../logger'
import { defineAiFunction } from '../utils/defineAiFunction'
import { TmpDirManager } from '../utils/tmpdir'

const docker = new Docker()

const tmpDirManager = new TmpDirManager()

export function createDockerFunctions(repoFullName?: string) {
  const logger = createLogger()
  const repoUrl = repoFullName ? `https://github.com/${repoFullName}.git` : undefined
  let repoDir: string | undefined
  let containerId: string | undefined

  const buildImage = defineAiFunction({
    name: 'buildImage',
    description: 'Build a Docker image from a Dockerfile content, returns the image name on success. The repository will be available as a mounted volume in containers.',
    parameters: z.object({
      dockerfile: z.string().describe('The content of the Dockerfile.'),
      imageName: z.string().describe('The name to tag the built image.'),
    }),
    response: z.string(),
    implementation: async (args) => {
      const { dockerfile, imageName } = args

      // Clone the repository locally (separate from build context)
      if (repoUrl) {
        repoDir = await tmpDirManager.create('repo-clone')
        logger.debug(`Cloning repository ${repoUrl} into ${repoDir}`)
        execSync(`git clone ${repoUrl} ${repoDir}`, { stdio: 'inherit' })
      }

      // Create a separate temp directory for the build context (just the Dockerfile)
      const buildContextDir = await tmpDirManager.create('docker-build')
      const dockerfilePath = join(buildContextDir, 'Dockerfile')

      // Write the Dockerfile to the build context
      await writeFile(dockerfilePath, dockerfile)

      try {
        // Build the Docker image from the context directory
        const stream = await docker.buildImage({
          context: buildContextDir,
          src: ['Dockerfile'],
        }, { t: imageName })

        // Wait for the build to complete and check for errors
        const buildResult = await new Promise<any[]>((resolve, reject) => {
          docker.modem.followProgress(stream, (err, res) => {
            if (err) {
              const errorMessage = err instanceof Error ? err.message : String(err)
              reject(new Error(`Docker build failed: ${errorMessage}`))
              return
            }
            resolve(res)
          })
        })

        // Check if any build step failed
        const failedSteps = buildResult.filter(step => step.errorDetail || step.error)
        if (failedSteps.length > 0) {
          const firstError = failedSteps[0]
          const errorMessage = firstError.errorDetail?.message || firstError.error || 'Unknown build error'
          throw new Error(`Docker build failed: ${errorMessage}`)
        }

        // Verify the image was created successfully
        try {
          await docker.getImage(imageName).inspect()
          return imageName
        }
        catch (inspectError) {
          const errorMessage = inspectError instanceof Error ? inspectError.message : String(inspectError)
          throw new Error(`Image build completed but image '${imageName}' was not found: ${errorMessage}`)
        }
      }
      catch (buildError) {
        const errorMessage = buildError instanceof Error ? buildError.message : String(buildError)
        throw new Error(`Failed to build Docker image '${imageName}': ${errorMessage}`)
      }
    },
  })

  const createContainer = defineAiFunction({
    name: 'createContainer',
    description: 'Create and start a Docker container from an image, with the repository mounted as a volume.',
    parameters: z.object({
      imageName: z.string().describe('The name of the Docker image to use.'),
    }),
    response: z.string(),
    implementation: async (args) => {
      const { imageName } = args

      const binds = repoDir ? [`${repoDir}:/workspace`] : []

      const container = await docker.createContainer({
        Image: imageName,
        Cmd: ['tail', '-f', '/dev/null'],
        Tty: true,
        OpenStdin: true,
        HostConfig: {
          Binds: binds,
        },
      })
      await container.start()
      containerId = container.id
      return container.id
    },
  })

  const executeCommand = defineAiFunction({
    name: 'executeCommand',
    description: 'Execute a command inside the created Docker container, returns the command output.',
    parameters: z.object({
      command: z.string().describe('The command to execute.'),
    }),
    response: z.string(),
    implementation: async (args) => {
      const { command } = args

      if (!containerId) {
        throw new Error('No container has been created yet. Call createContainer first.')
      }

      const container = docker.getContainer(containerId)

      // Check if container is running, start it if not
      const info = await container.inspect()
      if (!info.State.Running) {
        await container.start()
      }

      const exec = await container.exec({
        Cmd: ['sh', '-c', command],
        AttachStdout: true,
        AttachStderr: true,
      })
      const stream = await exec.start({})

      // Skip the first 8 bytes (Docker exec protocol framing)
      // https://docs.docker.com/reference/api/engine/version/v1.51/#tag/Container/operation/ContainerAttach
      return await text(stream.map(chunk => chunk.subarray(8)))
    },
  })

  return {
    buildImage,
    createContainer,
    executeCommand,
  }
}
