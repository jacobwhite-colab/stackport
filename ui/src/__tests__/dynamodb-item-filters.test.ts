import { describe, expect, it } from 'vitest'
import type { DynamoDBItem } from '@/lib/types'
import { filterDynamoDBItems, type DynamoDBItemFilter, type ItemFilterOperator } from '@/lib/dynamodb-item-filters'

const filter = (column: string, operator: ItemFilterOperator, value: string): DynamoDBItemFilter => ({ column, operator, value })

describe('DynamoDB item text filters', () => {
  it.each<[ItemFilterOperator, string, boolean]>([
    ['contains', 'PHA', true], ['contains', 'omega', false],
    ['not-contains', 'omega', true], ['not-contains', 'PHA', false],
    ['equals', 'ALPHABET', true], ['equals', 'alpha', false],
    ['not-equals', 'alpha', true], ['not-equals', 'ALPHABET', false],
    ['starts-with', 'ALP', true], ['starts-with', 'pha', false],
    ['ends-with', 'BET', true], ['ends-with', 'alpha', false],
    ['greater-than', 'alpha', true], ['greater-than', 'zebra', false],
    ['greater-or-equal', 'alphabet', true], ['greater-or-equal', 'zebra', false],
    ['less-than', 'zebra', true], ['less-than', 'alpha', false],
    ['less-or-equal', 'alphabet', true], ['less-or-equal', 'alpha', false],
  ])('%s %s matches Alphabet: %s', (operator, value, expected) => {
    expect(filterDynamoDBItems([{ name: { S: 'Alphabet' } }], [filter('name', operator, value)]).length > 0).toBe(expected)
  })

  it('supports all/any matching and preserves the original typed items for editing', () => {
    const items: DynamoDBItem[] = [{ name: { S: 'Ada' }, score: { N: '95' } }, { name: { S: 'Grace' }, score: { N: '98' } }]
    const filters = [filter('name', 'contains', 'ada'), filter('score', 'equals', '98')]
    expect(filterDynamoDBItems(items, filters, 'all')).toEqual([])
    expect(filterDynamoDBItems(items, filters, 'any')).toEqual(items)
    expect(filterDynamoDBItems(items, [filters[0]])[0]).toBe(items[0])
  })

  it('ignores unfinished optional filters and preserves literal search whitespace', () => {
    const items: DynamoDBItem[] = [{ name: { S: ' Ada ' } }]
    expect(filterDynamoDBItems(items, [filter('', 'equals', 'Ada'), filter('name', 'equals', '')])).toBe(items)
    expect(filterDynamoDBItems(items, [filter('name', 'contains', ' ')])).toEqual(items)
  })

  it('can match case while keeping column names case-sensitive', () => {
    const items: DynamoDBItem[] = [{ name: { S: 'Ada' } }]
    expect(filterDynamoDBItems(items, [filter('name', 'equals', 'ADA')], 'all', true)).toEqual([])
    expect(filterDynamoDBItems(items, [filter('name', 'equals', 'Ada')], 'all', true)).toEqual(items)
    expect(filterDynamoDBItems(items, [filter('NAME', 'equals', 'Ada')])).toEqual([])
  })

  it('compares numbers as text and keeps large numeric values exact', () => {
    const items: DynamoDBItem[] = [{ count: { N: '10' }, big: { N: '12345678901234567890123456789012345678' }, zero: { N: '0' } }]
    expect(filterDynamoDBItems(items, [filter('count', 'less-than', '2')])).toEqual(items)
    expect(filterDynamoDBItems(items, [filter('count', 'greater-than', '2')])).toEqual([])
    expect(filterDynamoDBItems(items, [filter('big', 'equals', '12345678901234567890123456789012345678')])).toEqual(items)
    expect(filterDynamoDBItems(items, [filter('zero', 'equals', '0')])).toEqual(items)
  })

  it('searches full compound values, booleans, and null as text', () => {
    const items: DynamoDBItem[] = [{
      data: { M: { prefix: { S: 'x'.repeat(100) }, suffix: { S: 'hidden needle' } } },
      active: { BOOL: false }, empty: { NULL: true }, tags: { SS: ['first', 'second'] },
    }]
    expect(filterDynamoDBItems(items, [filter('data', 'contains', 'hidden needle')])).toEqual(items)
    expect(filterDynamoDBItems(items, [filter('active', 'equals', 'false')])).toEqual(items)
    expect(filterDynamoDBItems(items, [filter('empty', 'equals', 'null')])).toEqual(items)
    expect(filterDynamoDBItems(items, [filter('tags', 'contains', 'second')])).toEqual(items)
  })

  it('excludes absent attributes even for negative comparisons', () => {
    expect(filterDynamoDBItems([{ id: { S: '1' } }], [filter('missing', 'not-equals', 'value')])).toEqual([])
    expect(filterDynamoDBItems([{ id: { S: '1' } }], [filter('constructor', 'not-contains', 'value')])).toEqual([])
  })
})
