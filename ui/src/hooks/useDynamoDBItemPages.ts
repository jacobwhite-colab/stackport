import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { DynamoDBItem, DynamoDBScanResponse } from '@/lib/types'
import { filterDynamoDBItems, isItemFilterActive, type DynamoDBItemFilter, type ItemFilterMatchMode } from '@/lib/dynamodb-item-filters'

type FetchPage = (token: string | null) => Promise<DynamoDBScanResponse>

interface PageCursor {
  token: string | null
  offset: number
}

interface ItemPage {
  items: DynamoDBItem[]
  nextCursor: PageCursor | null
}

export function useDynamoDBItemPages(
  fetchPage: FetchPage | null,
  pageSize: number,
  filters: DynamoDBItemFilter[],
  matchMode: ItemFilterMatchMode,
  caseSensitive: boolean,
) {
  const [pages, setPages] = useState<ItemPage[]>([])
  const [currentPageIndex, setCurrentPageIndex] = useState(1)
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)
  const activeFilters = useMemo(() => filters.filter(isItemFilterActive), [filters])

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
            if (data.reset_pagination) {
              responses.clear()
              responses.set(null, Promise.resolve({ ...data, reset_pagination: false }))
            }
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

  const loadPage = useCallback(async (pageIndex: number, cursor: PageCursor, reset = false) => {
    if (!fetchPage) return
    const id = ++requestId.current
    setLoading(true)
    try {
      let resetPages = reset
      let targetPageIndex = pageIndex
      let next: PageCursor | null = cursor
      const items: DynamoDBItem[] = []
      const visited = new Set<string | null>()
      while (next && items.length < pageSize) {
        const token: string | null = next.token
        const offset: number = next.offset
        if (visited.has(token)) throw new Error('Pagination token did not advance')
        visited.add(token)
        const data = await cache.read(token)
        if (id !== requestId.current) return
        if (data.reset_pagination) {
          if (!resetPages) toast.info('Index scan restarted to recover pagination')
          items.length = 0
          visited.clear()
          resetPages = true
          targetPageIndex = 1
        }
        const responseToken: string | null = data.reset_pagination ? null : token
        const responseOffset: number = data.reset_pagination ? 0 : offset
        const matches = filterDynamoDBItems(data.items, activeFilters, matchMode, caseSensitive)
        const end = Math.min(matches.length, responseOffset + pageSize - items.length)
        items.push(...matches.slice(responseOffset, end))
        // A UI page can end partway through the matches in a cached response.
        next = end < matches.length
          ? { token: responseToken, offset: end }
          : data.next_token ? { token: data.next_token, offset: 0 } : null
        if (activeFilters.length === 0 && items.length > 0) break
      }

      if (items.length > 0) {
        const page = { items, nextCursor: next }
        setPages((previous) => resetPages ? [page] : [...previous, page])
        setCurrentPageIndex(targetPageIndex)
        return
      }

      // Exhausting an empty tail closes Next without creating a blank UI page.
      if (resetPages) setCurrentPageIndex(1)
      setPages((previous) => resetPages ? [] : previous.map((page, index) =>
        index === previous.length - 1 ? { ...page, nextCursor: null } : page,
      ))
    } catch (error) {
      if (id === requestId.current) toast.error(`Failed to load items: ${error}`)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [fetchPage, pageSize, cache, activeFilters, matchMode, caseSensitive])

  useEffect(() => {
    setPages([])
    setCurrentPageIndex(1)
    setLoading(!!fetchPage)
    if (fetchPage) void loadPage(1, { token: null, offset: 0 }, true)
    return () => {
      requestId.current += 1
    }
  }, [fetchPage, activeFilters, loadPage])

  const reload = () => {
    cache.clear()
    return loadPage(1, { token: null, offset: 0 }, true)
  }

  return { pages, currentPageIndex, setCurrentPageIndex, loading, loadPage, reload }
}
