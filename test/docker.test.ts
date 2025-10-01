import Docker from 'dockerode'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDockerFunctions } from '../src/tools/docker'

const docker = new Docker()

describe('docker tools', () => {
  const testImageName = 'flaki-test-node'

  beforeAll(async () => {
    try {
      await docker.ping()
    }
    catch {
      expect.fail('Docker daemon is not running or not accessible. Please ensure Docker is installed and running before executing these tests.')
    }
  })

  afterAll(async () => {
    try {
      const image = docker.getImage(testImageName)
      await image.remove({ force: true })
    }
    catch { }

    // Clean up any test images created during error testing
    const testImages = [
      'flaki-test-fail',
      'flaki-test-invalid-syntax',
      'flaki-test-missing-base',
      'flaki-test-copy-fail',
      'flaki-test-empty',
      'flaki-test-comments',
    ]

    for (const imageName of testImages) {
      try {
        const image = docker.getImage(imageName)
        await image.remove({ force: true })
      }
      catch { }
    }

    // Additional cleanup: remove any containers that might be left running
    try {
      const containers = await docker.listContainers({ all: true })
      for (const containerInfo of containers) {
        if (containerInfo.Names.some(name => name.includes('flaki-test'))) {
          try {
            const container = docker.getContainer(containerInfo.Id)
            await container.stop({ t: 0 })
            await container.remove({ force: true })
          }
          catch { }
        }
      }
    }
    catch { }

    // Additional cleanup: remove any images that might be left
    try {
      const images = await docker.listImages()
      for (const imageInfo of images) {
        if (imageInfo.RepoTags?.some(tag => tag.startsWith('flaki-test'))) {
          try {
            const image = docker.getImage(imageInfo.Id)
            await image.remove({ force: true })
          }
          catch { }
        }
      }
    }
    catch { }
  }, 15000)

  const nocodeRepo = 'kelseyhightower/nocode'
  const nocodeImageName = 'flaki-test-nocode'
  let nocodeContainerId: string

  // Create Docker functions for the nocode repository
  const { buildImage, createContainer, executeCommand } = createDockerFunctions(nocodeRepo)

  afterAll(async () => {
    if (nocodeContainerId) {
      try {
        const container = docker.getContainer(nocodeContainerId)
        await container.stop({ t: 0 })
        await container.remove({ force: true })
      }
      catch { }
    }

    try {
      const image = docker.getImage(nocodeImageName)
      await image.remove({ force: true })
    }
    catch { }

    // Additional cleanup for any nocode-related containers
    try {
      const containers = await docker.listContainers({ all: true })
      for (const containerInfo of containers) {
        if (containerInfo.Names.some(name => name.includes('nocode'))) {
          try {
            const container = docker.getContainer(containerInfo.Id)
            await container.stop({ t: 0 })
            await container.remove({ force: true })
          }
          catch { }
        }
      }
    }
    catch { }
  }, 15000)

  it('should build Docker image with repository cloning', async () => {
    // Dockerfile that works with repository mounted as volume
    const dockerfile = `
FROM node:24-alpine
RUN apk add --no-cache git
WORKDIR /workspace
CMD ["echo", "Repository available successfully"]
`

    // Build the image - this should clone the nocode repo locally
    const result = await buildImage.implementation({
      dockerfile,
      imageName: nocodeImageName,
    })

    expect(result).toMatch(nocodeImageName)

    // Verify image was created
    const images = await docker.listImages()
    const imageExists = images.some(img => img.RepoTags?.includes(`${nocodeImageName}:latest`))
    expect(imageExists).toBe(true)
  }, 120000)

  it.sequential('should create container and verify repository was cloned', async () => {
    // Create container from the built image
    const result = await createContainer.implementation({ imageName: nocodeImageName })
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
    nocodeContainerId = result

    // Verify container was created and is running
    const container = docker.getContainer(nocodeContainerId)
    const info = await container.inspect()
    expect(info.State.Running).toBe(true)
  }, 30000)

  it.sequential('should verify repository contents in container', async () => {
    // Check that the repository was cloned and contains expected files
    const result = await executeCommand.implementation({
      command: 'ls /workspace',
    })

    // The nocode repo should contain a README.md file
    expect(result).toMatchInlineSnapshot(`
        "CONTRIBUTING.md
        Dockerfile
        LICENSE
        README.md
        STYLE.md
        "
      `)

    // Check the content of README.md
    const readmeContent = await executeCommand.implementation({
      command: 'cat /workspace/README.md',
    })

    // The nocode README should contain "No Code" or similar content
    expect(readmeContent.toLowerCase()).toMatch(/no.?code/)
  }, 30000)

  it.sequential('should execute multi-line commands in container', async () => {
    const result = await executeCommand.implementation({
      command: 'echo "Line 1" && echo "Line 2" && pwd',
    })
    expect(result).toContain('Line 1')
    expect(result).toContain('Line 2')
    expect(result).toContain('/workspace') // Should be in WORKDIR
  }, 30000)

  it.sequential('should handle command execution errors', async () => {
    const result = await executeCommand.implementation({
      command: 'nonexistent-command',
    })
    expect(result).toMatchInlineSnapshot(`
        "sh: nonexistent-command: not found
        "
      `)
  }, 30000)

  it.sequential('should handle commands that exit with non-zero codes', async () => {
    const result = await executeCommand.implementation({
      command: 'exit 42',
    })
    expect(result).toMatchInlineSnapshot(`
        ""
      `)
  }, 30000)

  it.sequential('should fail when no container has been created', async () => {
    // Create a new instance of docker functions without creating a container
    const { executeCommand: freshExecuteCommand } = createDockerFunctions(nocodeRepo)

    await expect(freshExecuteCommand.implementation({
      command: 'echo "should not work"',
    })).rejects.toThrow('No container has been created yet. Call createContainer first.')
  }, 30000)
})
