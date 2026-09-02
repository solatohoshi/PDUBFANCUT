export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'

export function idParams(name = 'id') {
  return {
    type: 'object',
    additionalProperties: false,
    required: [name],
    properties: { [name]: { type: 'string', pattern: UUID_PATTERN } },
  } as const
}

export const projectCreateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'analysisMode'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 160 },
    analysisMode: { type: 'string', enum: ['full', 'quick'] },
    quickSearchParams: {
      type: 'object',
      additionalProperties: false,
      properties: {
        players: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } },
        scenes: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } },
      },
    },
  },
} as const

export const emptyBody = {
  type: 'object',
  additionalProperties: false,
} as const
