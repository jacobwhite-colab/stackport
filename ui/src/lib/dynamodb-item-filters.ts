import type { DynamoDBItem } from '@/lib/types'
import { dynamoItemToPlainMap } from '@/lib/dynamodb-marshal'

export const ITEM_FILTER_OPERATORS = [
  { value: 'contains', label: 'Contains' },
  { value: 'not-contains', label: 'Does not contain' },
  { value: 'equals', label: 'Equals' },
  { value: 'not-equals', label: 'Does not equal' },
  { value: 'starts-with', label: 'Starts with' },
  { value: 'ends-with', label: 'Ends with' },
  { value: 'greater-than', label: 'Greater than' },
  { value: 'greater-or-equal', label: 'Greater than or equal' },
  { value: 'less-than', label: 'Less than' },
  { value: 'less-or-equal', label: 'Less than or equal' },
] as const

export type ItemFilterOperator = typeof ITEM_FILTER_OPERATORS[number]['value']
export type ItemFilterMatchMode = 'all' | 'any'
export interface DynamoDBItemFilter {
  column: string
  operator: ItemFilterOperator
  value: string
}

export function isItemFilterActive(filter: DynamoDBItemFilter): boolean {
  return filter.column.trim().length > 0 && filter.value.length > 0
}

function attributeText(attribute: unknown): string {
  // Keep numeric attributes as their original text, including large integers.
  if (attribute && typeof attribute === 'object' && 'N' in attribute) return String(attribute.N)
  const value = dynamoItemToPlainMap({ value: attribute }).value
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function compareText(text: string, value: string, operator: ItemFilterOperator): boolean {
  switch (operator) {
    case 'contains': return text.includes(value)
    case 'not-contains': return !text.includes(value)
    case 'equals': return text === value
    case 'not-equals': return text !== value
    case 'starts-with': return text.startsWith(value)
    case 'ends-with': return text.endsWith(value)
    case 'greater-than': return text > value
    case 'greater-or-equal': return text >= value
    case 'less-than': return text < value
    case 'less-or-equal': return text <= value
  }
}

export function filterDynamoDBItems(
  items: DynamoDBItem[],
  filters: DynamoDBItemFilter[],
  matchMode: ItemFilterMatchMode = 'all',
  caseSensitive = false,
): DynamoDBItem[] {
  const active = filters.filter(isItemFilterActive)
  if (active.length === 0) return items

  return items.filter((item) => {
    const matches = (filter: DynamoDBItemFilter) => {
      const column = filter.column.trim()
      if (!Object.hasOwn(item, column)) return false
      let text = attributeText(item[column])
      let value = filter.value
      if (!caseSensitive) {
        text = text.toLowerCase()
        value = value.toLowerCase()
      }
      return compareText(text, value, filter.operator)
    }
    return matchMode === 'all' ? active.every(matches) : active.some(matches)
  })
}
