import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { DynamoDBScanResponse } from '@/lib/types'
import { filterDynamoDBItems, isItemFilterActive, type DynamoDBItemFilter, type ItemFilterMatchMode } from '@/lib/dynamodb-item-filters'

type FetchPage = (token: string | null) => Promise<DynamoDBScanResponse>

export function useDynamoDBItemPages(
  fetchPage: FetchPage | null,
  filters: DynamoDBItemFilter[],
  matchMode: ItemFilterMatchMode,
  caseSensitive: boolean,
) {
  const [pages, setPages] = useState<DynamoDBScanResponse[]>([])
  const [currentPageIndex, setCurrentPageIndex] = useState(1)
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)
  // Incomplete filter rows don't change the results or restart a search.
  const filterKey = JSON.stringify(filters.filter(isItemFilterActive))
  const activeFilters = useMemo(() => JSON.parse(filterKey) as DynamoDBItemFilter[], [filterKey])

  const cache = useMemo(() => {
    const responses = new Map<string | null, Promise<DynamoDBScanResponse>>()
    return {
      clear: () => responses.clear(),
      read: (token: string | null) => {
        if (!fetchPage) throw new Error('Run a query first')
        let response = responses.get(token)
        if (!response) {
          const pending = fetchPage(token).then((data) => {
            if ('error' in data) throw new Error(String(data.error))
            return data
          }).catch((error: unknown) => {
            if (responses.get(token) === pending) responses.delete(token)
            throw error
          })
          responses.set(token, pending)
          response = pending
        }
        return response
      },
    }
  }, [fetchPage])

  const loadPage = useCallback(async (pageIndex: number, token: string | null, reset = false) => {
    if (!fetchPage) return
    const id = ++requestId.current
    setLoading(true)
    try {
      let next = token
      const visited = new Set<string | null>()
      do {
        if (visited.has(next)) throw new Error('Pagination token did not advance')
        visited.add(next)
        const data = await cache.read(next)
        if (id !== requestId.current) return
        if (activeFilters.length === 0 || filterDynamoDBItems(data.items, activeFilters, matchMode, caseSensitive).length > 0) {
          setPages((previous) => reset ? [data] : [...previous, data])
          setCurrentPageIndex(pageIndex)
          return
        }
        next = data.next_token
      } while (next)

      // Exhausting an empty tail closes Next without creating a blank UI page.
      setPages((previous) => reset ? [] : previous.map((page, index) =>
        index === previous.length - 1 ? { ...page, next_token: null } : page,
      ))
    } catch (error) {
      if (id === requestId.current) toast.error(`Failed to load items: ${error}`)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [fetchPage, cache, activeFilters, matchMode, caseSensitive])

  useEffect(() => {
    setPages([])
    setCurrentPageIndex(1)
    setLoading(!!fetchPage)
    // Debounce edits while keeping cached responses available to the next search.
    const timer = fetchPage && activeFilters.length > 0
      ? setTimeout(() => { void loadPage(1, null, true) }, 200)
      : undefined
    if (fetchPage && !timer) void loadPage(1, null, true)
    return () => {
      clearTimeout(timer)
      requestId.current += 1
    }
  }, [fetchPage, activeFilters, loadPage])

  const reload = () => {
    cache.clear()
    return loadPage(1, null, true)
  }

  return { pages, currentPageIndex, setCurrentPageIndex, loading, loadPage, reload }
}
