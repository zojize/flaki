// @ts-check
import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
  },
)
  .overrideRules({
    'no-console': 'off',
    'ts/explicit-function-return-type': 'off',
  })
