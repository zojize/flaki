import type { FunctionDeclaration } from '@google/genai'
import * as z from 'zod'

export interface AiFunction<
  Params extends z.ZodType = z.ZodType,
  Response extends z.ZodType = z.ZodType,
> {
  declaration: FunctionDeclaration
  implementation: (args: z.infer<Params>) => Promise<z.infer<Response>> | z.infer<Response>
}

export function defineAiFunction<
  Params extends z.ZodType,
  Response extends z.ZodType = z.ZodVoid,
>({
  name,
  description,
  parameters,
  response,
  implementation,
}: {
  name: string
  description: string
  parameters: Params
  response?: Response
  implementation: (args: z.infer<Params>) => Promise<z.infer<Response>> | z.infer<Response>
}): AiFunction<Params, Response> {
  return {
    declaration: {
      name,
      description,
      parametersJsonSchema: z.toJSONSchema(parameters),
      ...response ? { responseJsonSchema: z.toJSONSchema(response) } : {},
    },
    implementation,
  }
}

export async function runAiFunction(func: Record<string, AiFunction>, name: string, args: unknown): Promise<unknown> {
  const f = func[name]
  if (!f)
    throw new Error(`Function '${name}' not found`)
  return f.implementation(args)
}
