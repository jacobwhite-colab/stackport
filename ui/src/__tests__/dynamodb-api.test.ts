import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  batchWriteDynamoDBItems,
  deleteDynamoDBItem,
  fetchDynamoDBTable,
  fetchDynamoDBItem,
  fetchDynamoDBItems,
  fetchDynamoDBTables,
  putDynamoDBItem,
  queryDynamoDBTable,
  updateDynamoDBItem,
} from '@/lib/api'

const mockFetch = vi.fn()
globalThis.fetch = mockFetch

beforeEach(() => {
  mockFetch.mockReset()
})

function mockOk(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  })
}

function mockError(status: number) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    statusText: 'Error',
    json: () => Promise.resolve({}),
  })
}

describe('fetchDynamoDBTables', () => {
  it('calls the correct URL', async () => {
    const data = { tables: [] }
    mockOk(data)
    const result = await fetchDynamoDBTables()
    expect(mockFetch).toHaveBeenCalledWith('/api/dynamodb/tables')
    expect(result.tables).toEqual([])
  })

  it('throws on non-ok response', async () => {
    mockError(500)
    await expect(fetchDynamoDBTables()).rejects.toThrow('500')
  })
})

describe('fetchDynamoDBTable', () => {
  it('calls correct URL with encoded name', async () => {
    mockOk({ name: 'my-table', status: 'ACTIVE' })
    await fetchDynamoDBTable('my-table')
    expect(mockFetch).toHaveBeenCalledWith('/api/dynamodb/tables/my-table')
  })

  it('encodes special characters in table name', async () => {
    mockOk({ name: 'my table', status: 'ACTIVE' })
    await fetchDynamoDBTable('my table')
    expect(mockFetch).toHaveBeenCalledWith('/api/dynamodb/tables/my%20table')
  })
})

describe('fetchDynamoDBItems', () => {
  it('keeps the selected index and endpoint on paginated scans', async () => {
    mockOk({ items: [], next_token: null })
    await fetchDynamoDBItems('users', 50, 'cursor+/=', 'local', 'by-status')
    const url = new URL(mockFetch.mock.calls[0][0], 'http://localhost')
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50', exclusive_start_key: 'cursor+/=', index_name: 'by-status', endpoint: 'local' })
  })

  it('calls correct URL with default params', async () => {
    mockOk({ table: 'users', items: [], count: 0 })
    await fetchDynamoDBItems('users')
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('/api/dynamodb/tables/users/items')
    expect(url).toContain('limit=25')
  })

  it('passes custom limit', async () => {
    mockOk({ table: 'users', items: [], count: 0 })
    await fetchDynamoDBItems('users', 50)
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('limit=50')
  })

  it('passes next token for pagination', async () => {
    mockOk({ table: 'users', items: [], count: 0 })
    await fetchDynamoDBItems('users', 25, 'abc123')
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).toContain('exclusive_start_key=abc123')
  })

  it('omits next token when null', async () => {
    mockOk({ table: 'users', items: [], count: 0 })
    await fetchDynamoDBItems('users', 25, null)
    const url = mockFetch.mock.calls[0][0] as string
    expect(url).not.toContain('exclusive_start_key')
  })
})

describe('queryDynamoDBTable', () => {
  it('forwards the continuation token and returns the next query page token', async () => {
    mockOk({ table: 'users', items: [], count: 0, scanned_count: 0, next_token: 'next-page' })
    const result = await queryDynamoDBTable('users', {
      partition_key_value: 'user1', limit: 50, exclusive_start_key: 'previous-page', index_name: 'by-status',
    })
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({
      exclusive_start_key: 'previous-page', limit: 50, index_name: 'by-status',
    })
    expect(result.next_token).toBe('next-page')
  })

  it('sends POST with correct body', async () => {
    mockOk({ table: 'users', items: [], count: 0 })
    await queryDynamoDBTable('users', {
      partition_key_value: 'user1',
      sort_key_value: 'profile',
      sort_key_operator: '=',
      limit: 25,
    })
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/dynamodb/tables/users/query',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.partition_key_value).toBe('user1')
    expect(body.sort_key_value).toBe('profile')
    expect(body.sort_key_operator).toBe('=')
    expect(body.limit).toBe(25)
  })

  it('throws on non-ok response', async () => {
    mockError(400)
    await expect(
      queryDynamoDBTable('users', { partition_key_value: 'test' })
    ).rejects.toThrow('400')
  })
})

describe('fetchDynamoDBItem', () => {
  it('loads the complete base-table item using its typed primary key', async () => {
    const key = { id: { B: 'AI7/' }, revision: { N: '9007199254740993' } }
    const item = { ...key, extra: { S: 'not projected' } }
    mockOk({ table: 'users', item })
    expect(await fetchDynamoDBItem('users', key, 'local')).toEqual(item)
    const url = new URL(mockFetch.mock.calls[0][0], 'http://localhost')
    expect(url.pathname).toBe('/api/dynamodb/tables/users/item')
    expect(JSON.parse(url.searchParams.get('key')!)).toEqual(key)
    expect(url.searchParams.get('endpoint')).toBe('local')
  })

  it('rejects a missing item instead of returning an index projection for editing', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({ detail: 'Item no longer exists' }) })
    await expect(fetchDynamoDBItem('users', { id: { S: 'gone' } })).rejects.toThrow('404: Item no longer exists')
  })
})

describe('putDynamoDBItem / updateDynamoDBItem / deleteDynamoDBItem / batchWriteDynamoDBItems', () => {
  it('putDynamoDBItem uses POST and JSON body', async () => {
    mockOk({ ok: true, table: 't' })
    await putDynamoDBItem('t', { pk: { S: 'a' } }, 'dynamodb')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/dynamodb/tables/t/items',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ item: { pk: { S: 'a' } }, item_format: 'dynamodb' }),
      })
    )
  })

  it('updateDynamoDBItem uses PUT', async () => {
    mockOk({ ok: true, table: 't' })
    await updateDynamoDBItem('t', { pk: { S: 'a' } }, 'dynamodb')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/dynamodb/tables/t/items',
      expect.objectContaining({ method: 'PUT' })
    )
  })

  it('deleteDynamoDBItem sends DELETE with key body', async () => {
    mockOk({ ok: true, table: 't' })
    await deleteDynamoDBItem('t', { pk: { S: 'a' } })
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/dynamodb/tables/t/items',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ key: { pk: { S: 'a' } }, item_format: 'dynamodb' }),
      })
    )
  })

  it('batchWriteDynamoDBItems posts to batch path', async () => {
    mockOk({ ok: true, table: 't' })
    const ops = [
      { op: 'put' as const, item: { pk: { S: '1' } } },
      { op: 'delete' as const, key: { pk: { S: '2' } } },
    ]
    await batchWriteDynamoDBItems('t', ops)
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/dynamodb/tables/t/items/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ item_format: 'dynamodb', operations: ops }),
      })
    )
  })

  it('batchWriteDynamoDBItems forwards unprocessed items so callers can warn', async () => {
    const unprocessed = { t: [{ PutRequest: { Item: { pk: { S: '1' } } } }] }
    mockOk({ ok: true, table: 't', unprocessed, message: 'partial' })
    const resp = await batchWriteDynamoDBItems('t', [
      { op: 'put' as const, item: { pk: { S: '1' } } },
    ])
    expect(resp.unprocessed).toEqual(unprocessed)
    expect(resp.message).toBe('partial')
  })
})
