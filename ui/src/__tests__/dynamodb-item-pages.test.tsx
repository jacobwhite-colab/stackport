import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDynamoDBItemPages } from '@/hooks/useDynamoDBItemPages'
import type { DynamoDBItemFilter } from '@/lib/dynamodb-item-filters'
import type { DynamoDBItem, DynamoDBScanResponse } from '@/lib/types'

const filters: DynamoDBItemFilter[] = [{ column: 'name', operator: 'equals', value: 'Ada' }]
const items = (prefix: string, count: number, name = 'Ada'): DynamoDBItem[] =>
  Array.from({ length: count }, (_, index) => ({ id: { S: `${prefix}-${index}` }, name: { S: name } }))
const response = (rows: DynamoDBItem[], next_token: string | null, reset_pagination = false): DynamoDBScanResponse =>
  ({ table: 'test', items: rows, count: rows.length, scanned_count: rows.length, next_token, reset_pagination })

describe('DynamoDB item page packing', () => {
  it('combines 58 and 31 matches into one page at a target of 100', async () => {
    const first = items('first', 58)
    const second = items('second', 31)
    const fetch = vi.fn(async (token: string | null) => token
      ? response([...second, ...items('skip-second', 69, 'Grace')], null)
      : response([...first, ...items('skip-first', 42, 'Grace')], 'next'))
    const { result } = renderHook(() => useDynamoDBItemPages(fetch, 100, filters, 'all', false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pages).toHaveLength(1)
    expect(result.current.pages[0].items).toEqual([...first, ...second])
    expect(result.current.pages[0].nextCursor).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('keeps the remaining 25 matches when 125 results span two 100-item pages', async () => {
    const first = items('first', 58)
    const second = items('second', 67)
    const expected = [...first, ...second]
    const fetch = vi.fn(async (token: string | null) => token
      ? response([...second, ...items('skip-second', 33, 'Grace')], null)
      : response([...first, ...items('skip-first', 42, 'Grace')], 'next'))
    const { result } = renderHook(() => useDynamoDBItemPages(fetch, 100, filters, 'all', false))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pages[0].items).toEqual(expected.slice(0, 100))
    await act(async () => { await result.current.loadPage(2, result.current.pages[0].nextCursor!) })
    expect(result.current.pages[1].items).toEqual(expected.slice(100))
    expect(result.current.pages[1].nextCursor).toBeNull()
    act(() => result.current.setCurrentPageIndex(1))
    expect(result.current.pages[result.current.currentPageIndex - 1].items).toEqual(expected.slice(0, 100))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('discards partial native results and reuses the correct cache after a compatibility restart', async () => {
    const corrected = [...items('corrected', 20), ...items('skip-corrected', 5, 'Grace')]
    const following = items('following', 10)
    const fetch = vi.fn(async (token: string | null) => {
      if (token === 'bad') return response(corrected, 'compatible', true)
      if (token === 'compatible') return response(following, null)
      return response([...items('old', 10), ...items('skip-old', 15, 'Grace')], 'bad')
    })
    const { result, rerender } = renderHook(({ applied }) => useDynamoDBItemPages(fetch, 25, applied, 'all', false), { initialProps: { applied: filters } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    const expected = [...corrected.slice(0, 20), ...following]
    expect(result.current.currentPageIndex).toBe(1)
    expect(result.current.pages[0].items).toEqual(expected.slice(0, 25))
    await act(async () => { await result.current.loadPage(2, result.current.pages[0].nextCursor!) })
    expect(result.current.pages[1].items).toEqual(expected.slice(25))
    rerender({ applied: [...filters] })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.pages[0].items).toEqual(expected.slice(0, 25))
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
