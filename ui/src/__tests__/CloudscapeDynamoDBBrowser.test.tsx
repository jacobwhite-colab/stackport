import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import createWrapper from '@cloudscape-design/components/test-utils/dom'
import type { DynamoDBItem } from '@/lib/types'

vi.mock('@/hooks/useEndpoint', () => ({
  useEndpoint: () => ({
    activeEndpoint: 'local',
    endpoints: [],
    loading: false,
    setActiveEndpoint: vi.fn(),
    refresh: vi.fn(),
  }),
}))

vi.mock('@/hooks/useHealth', () => ({
  useHealth: () => ({
    data: {
      status: 'ok',
      version: 'test',
      uptime_seconds: 1,
      endpoint_url: 'http://localhost:4566',
      region: 'us-east-1',
      services_count: 1,
      connection_type: 'local',
      writes_enabled: true,
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}))

import CloudscapeResourceBrowser from '@/pages/CloudscapeResourceBrowser'

const statsPayload = {
  services: { dynamodb: { status: 'available', resources: { tables: 1 } } },
  total_resources: 1,
  uptime_seconds: 60,
}

const tablesPayload = {
  tables: [
    {
      name: 'learners',
      status: 'ACTIVE',
      item_count: 2,
      size_bytes: 2048,
      partition_key: 'id',
      sort_key: null,
      billing_mode: 'PAY_PER_REQUEST',
      created: '2026-01-01T00:00:00Z',
    },
  ],
}

const tableDetail = {
  ...tablesPayload.tables[0],
  partition_key_type: 'S',
  sort_key_type: null,
  attribute_definitions: { id: 'S' },
  key_schema: [{ AttributeName: 'id', KeyType: 'HASH' }],
  global_secondary_indexes: [],
  local_secondary_indexes: [],
}

const scanPayload = {
  table: 'learners',
  items: [
    { id: { S: '1' }, name: { S: 'Ada' }, score: { N: '95' }, tags: { SS: ['a', 'b'] } },
    { id: { S: '2' }, name: { S: 'Grace' }, score: { N: '98' } },
  ],
  count: 2,
  scanned_count: 2,
  next_token: null,
}

const queryPayload = {
  table: 'learners',
  items: [{ id: { S: '1' }, name: { S: 'Ada' }, score: { N: '95' } }],
  count: 1,
  scanned_count: 1,
  next_token: null,
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let fetchMock: ReturnType<typeof vi.fn<FetchImplementation>>

function mockFetchByUrl(overrides: { tableDetail?: unknown; scanPayload?: unknown; queryPayload?: unknown } = {}) {
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    let payload: unknown = statsPayload
    if (url.includes('/items/batch')) payload = { ok: true, table: 'learners' }
    else if (url.includes('/query')) payload = overrides.queryPayload ?? queryPayload
    else if (url.includes('/items')) payload = method === 'GET' ? overrides.scanPayload ?? scanPayload : { ok: true, table: 'learners' }
    else if (url.includes('/tags')) payload = { tags: {} }
    else if (url.includes('/api/dynamodb/tables/learners')) payload = overrides.tableDetail ?? tableDetail
    else if (url.includes('/api/dynamodb/tables')) payload = tablesPayload
    else if (url.includes('/api/stats')) payload = statsPayload
    return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) } as Response)
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
}

function mockItemPages(pages: DynamoDBItem[][]) {
  mockFetchByUrl()
  const originalFetch = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/query') || (url.pathname.endsWith('/items') && !init?.method)) {
      const token = url.pathname.endsWith('/query')
        ? JSON.parse(init!.body as string).exclusive_start_key
        : url.searchParams.get('exclusive_start_key')
      const index = token ? Number(token.split('-')[1]) : 0
      const items = pages[index]
      if (!items) throw new Error(`Unexpected page request: ${token}`)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        ...scanPayload, items, count: items.length, scanned_count: items.length,
        next_token: index < pages.length - 1 ? `cursor-${index + 1}` : null,
      }) } as Response)
    }
    return originalFetch(input, init)
  })
}

function renderDynamo(path = '/resources/dynamodb') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/resources/:service" element={<CloudscapeResourceBrowser />} />
      </Routes>
    </MemoryRouter>,
  )
}

function fillFilter(index: number, column: string, value: string) {
  fireEvent.change(screen.getByLabelText(`Filter ${index} column`), { target: { value: column } })
  fireEvent.change(screen.getByRole('textbox', { name: `Filter ${index} search text` }), { target: { value } })
}

function chooseFilterOperator(index: number, value: string) {
  const field = createWrapper(document.body).findAttributeEditor()!.findRow(index)!.findField(2)!.getElement()
  const select = createWrapper(field).findSelect()!
  act(() => select.openDropdown())
  act(() => select.selectOptionByValue(value))
}

beforeEach(() => {
  localStorage.clear()
  mockFetchByUrl()
})

describe('CloudscapeDynamoDBBrowser (via registry dispatch)', () => {
  it('lists tables with keys and billing', async () => {
    renderDynamo()
    expect(await screen.findByText('learners')).toBeInTheDocument()
    expect(await screen.findByText('PAY_PER_REQUEST')).toBeInTheDocument()
    expect(await screen.findByText('2.0 KB')).toBeInTheDocument()
  })

  it('opens the table and scans items', async () => {
    renderDynamo()
    fireEvent.click(await screen.findByRole('link', { name: 'learners' }))
    expect(await screen.findByText('id (S)')).toBeInTheDocument()
    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(await screen.findByText('Grace')).toBeInTheDocument()
  })

  it('uses partition key values for editing and keeps deletion in the selection toolbar', async () => {
    renderDynamo('/resources/dynamodb?table=learners')
    const row = (await screen.findByText('Ada')).closest('tr')!
    expect(within(row).getByRole('button', { name: 'Edit item with id: 1' })).toHaveTextContent('1')
    expect(within(row).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete selected (0)' })).toBeDisabled()

    fireEvent.click(within(row).getByRole('checkbox'))
    expect(screen.getByRole('button', { name: 'Delete selected (1)' })).toBeEnabled()
  })

  it('edits and batch-deletes the correct item when rows share a partition key', async () => {
    mockFetchByUrl({
      tableDetail: { ...tableDetail, sort_key: 'revision', sort_key_type: 'N' },
      scanPayload: {
        ...scanPayload,
        items: [
          { id: { S: 'shared' }, revision: { N: '1' }, name: { S: 'Ada' } },
          { id: { S: 'shared' }, revision: { N: '2' }, name: { S: 'Grace' } },
        ],
      },
    })
    renderDynamo('/resources/dynamodb?table=learners')
    const row = (await screen.findByText('Grace')).closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: 'Edit item with id: shared' }))

    const dialog = await screen.findByRole('dialog', { name: 'Edit item' })
    const textarea = within(dialog).getByRole('textbox') as HTMLTextAreaElement
    expect(JSON.parse(textarea.value)).toEqual({ id: 'shared', revision: 2, name: 'Grace' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(row).getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }))
    await waitFor(() => {
      const batchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/items/batch'))
      expect(batchCall).toBeTruthy()
      const body = JSON.parse((batchCall![1] as RequestInit).body as string)
      expect(body.operations).toEqual([{ op: 'delete', key: { id: { S: 'shared' }, revision: { N: '2' } } }])
    })
  })

  it('runs a query with the typed partition key', async () => {
    renderDynamo()
    fireEvent.click(await screen.findByRole('link', { name: 'learners' }))
    await screen.findByText('Ada')
    fireEvent.click(screen.getByText('Query'))
    const pkInput = screen.getAllByRole('textbox')[0]
    fireEvent.change(pkInput, { target: { value: '1' } })
    fireEvent.click(screen.getByText('Run query'))

    await waitFor(() => {
      const queryCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/query'))
      expect(queryCall).toBeTruthy()
    })
    const queryCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/query'))
    const body = JSON.parse((queryCall![1] as RequestInit).body as string)
    expect(body.partition_key_value).toBe('1')
  })

  it('creates an item prefilled with the key skeleton and converts formats', async () => {
    renderDynamo()
    fireEvent.click(await screen.findByRole('link', { name: 'learners' }))
    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Create item' }))

    const textarea = (await screen.findAllByRole('textbox')).find((el) => el.tagName === 'TEXTAREA') as HTMLTextAreaElement
    expect(textarea.value).toContain('"id"')

    fireEvent.change(textarea, { target: { value: '{"id": "3", "name": "Alan"}' } })
    fireEvent.click(screen.getByText('DynamoDB JSON'))
    await waitFor(() => {
      const updated = (screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA') as HTMLTextAreaElement).value
      expect(updated).toContain('"S": "Alan"')
    })

    const buttons = screen.getAllByRole('button', { name: 'Create item' })
    fireEvent.click(buttons[buttons.length - 1])
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).includes('/items?') && (init as RequestInit)?.method === 'POST',
      )
      expect(postCall).toBeTruthy()
      const body = JSON.parse((postCall![1] as RequestInit).body as string)
      expect(body.item_format).toBe('dynamodb')
      expect(body.item.name.S).toBe('Alan')
    })
  })

  it('renders scanned items as plain values, not DynamoDB-typed JSON', async () => {
    renderDynamo()
    fireEvent.click(await screen.findByRole('link', { name: 'learners' }))
    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(screen.getByText('95')).toBeInTheDocument()
    expect(screen.queryByText(/"S":/)).not.toBeInTheDocument()
    expect(screen.queryByText(/"N":/)).not.toBeInTheDocument()
  })

  it('opens an existing item as plain JSON and shows exact DynamoDB JSON on switch', async () => {
    renderDynamo()
    fireEvent.click(await screen.findByRole('link', { name: 'learners' }))
    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Edit item with id: 1' }))

    const getTextarea = () =>
      screen.getAllByRole('textbox').find((el) => el.tagName === 'TEXTAREA') as HTMLTextAreaElement
    await waitFor(() => expect(JSON.parse(getTextarea().value)).toEqual({ id: '1', name: 'Ada', score: 95, tags: ['a', 'b'] }))

    fireEvent.click(screen.getByText('DynamoDB JSON'))
    await waitFor(() =>
      expect(JSON.parse(getTextarea().value)).toEqual({
        id: { S: '1' },
        name: { S: 'Ada' },
        score: { N: '95' },
        tags: { SS: ['a', 'b'] },
      }),
    )

    fireEvent.click(screen.getByText('Plain JSON'))
    await waitFor(() => expect(JSON.parse(getTextarea().value)).toEqual({ id: '1', name: 'Ada', score: 95, tags: ['a', 'b'] }))
  })

  it('saves an edited item without double-encoding it', async () => {
    renderDynamo()
    fireEvent.click(await screen.findByRole('link', { name: 'learners' }))
    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Edit item with id: 2' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Save item' }))

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).includes('/items?') && (init as RequestInit)?.method === 'PUT',
      )
      expect(putCall).toBeTruthy()
      const body = JSON.parse((putCall![1] as RequestInit).body as string)
      expect(body.item_format).toBe('plain')
      expect(body.item).toEqual({ id: '2', name: 'Grace', score: 98 })
    })
  })

  it('batch-deletes selected items', async () => {
    renderDynamo()
    fireEvent.click(await screen.findByRole('link', { name: 'learners' }))
    await screen.findByText('Ada')

    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]) // select all
    fireEvent.click(screen.getByText(/Delete selected \(2\)/))

    await waitFor(() => {
      const batchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/items/batch'))
      expect(batchCall).toBeTruthy()
    })
    const batchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/items/batch'))
    const body = JSON.parse((batchCall![1] as RequestInit).body as string)
    expect(body.operations).toHaveLength(2)
    expect(body.operations[0].op).toBe('delete')
    expect(body.operations[0].key.id.S).toBe('1')
  })

  it('adds, combines, removes, and clears optional text filters without refetching', async () => {
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Ada')
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    expect(screen.getByText('Grace')).toBeInTheDocument()
    fillFilter(1, 'name', 'ADA')
    await screen.findByText('Ada')
    expect(screen.queryByText('Grace')).not.toBeInTheDocument()
    expect(screen.getByText('(1 matching)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Match case' }))
    await screen.findByText('No items match these filters')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Match case' }))
    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fillFilter(2, 'score', '98')
    chooseFilterOperator(2, 'equals')
    await screen.findByText('No items match these filters')
    fireEvent.click(screen.getByText('Any filter'))
    await screen.findByText('Ada')
    expect(screen.getByText('Grace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter 2' }))
    await screen.findByText('Ada')
    expect(screen.queryByText('Grace')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await screen.findByText('Grace')
    expect(fetchMock.mock.calls).toHaveLength(callsBefore)
  })

  it('clears previous selections and bulk-deletes only selected filtered rows', async () => {
    renderDynamo('/resources/dynamodb?table=learners')
    const grace = (await screen.findByText('Grace')).closest('tr')!
    fireEvent.click(within(grace).getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fillFilter(1, 'name', 'Ada')
    expect(screen.getByRole('button', { name: 'Delete selected (0)' })).toBeDisabled()
    const table = (await screen.findByText('Ada')).closest('table')!
    fireEvent.click(within(table).getAllByRole('checkbox')[0])
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/items/batch'))
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as RequestInit).body as string).operations).toEqual([{ op: 'delete', key: { id: { S: '1' } } }])
    })
  })

  it('applies existing filters to query results and keeps key-value editing available', async () => {
    mockFetchByUrl({ queryPayload: scanPayload })
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fillFilter(1, 'name', 'Grace')
    fireEvent.click(screen.getByText('Query'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Partition key (id)' }), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }))
    await screen.findByRole('button', { name: 'Edit item with id: 2' })
    expect(screen.queryByText('Ada')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit item with id: 2' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit item' })
    expect(JSON.parse((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).name).toBe('Grace')
  })

  it.each(['scan', 'query'] as const)('automatically skips empty %s pages to show the first match as page 1', async (mode) => {
    mockItemPages([[scanPayload.items[1]], [], [scanPayload.items[0]]])
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Grace')
    if (mode === 'query') {
      fireEvent.click(screen.getByText('Query'))
      fireEvent.change(screen.getByRole('textbox', { name: 'Partition key (id)' }), { target: { value: '1' } })
      fireEvent.click(screen.getByRole('button', { name: 'Run query' }))
      await screen.findByText('Grace')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fillFilter(1, 'name', 'Ada')
    expect(await screen.findByText('Ada')).toBeInTheDocument()
    expect(screen.queryByText('Grace')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByRole('button', { name: 'Page 2' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous page' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveAttribute('aria-disabled', 'true')
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes(mode === 'scan' ? '/items?' : '/query'))
    expect(calls).toHaveLength(3)
    if (mode === 'query') expect(JSON.parse(calls[2][1]!.body as string)).toMatchObject({
      partition_key_value: '1', exclusive_start_key: 'cursor-2',
    })
  })

  it.each(['scan', 'query'] as const)('skips empty middle and trailing %s pages without adding blank page buttons', async (mode) => {
    const laterAda = { ...scanPayload.items[0], id: { S: '3' } }
    mockItemPages([[scanPayload.items[0]], [scanPayload.items[1]], [], [laterAda], [scanPayload.items[1]]])
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Ada')
    if (mode === 'query') {
      fireEvent.click(screen.getByText('Query'))
      fireEvent.change(screen.getByRole('textbox', { name: 'Partition key (id)' }), { target: { value: '1' } })
      fireEvent.click(screen.getByRole('button', { name: 'Run query' }))
      await screen.findByText('Ada')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fillFilter(1, 'name', 'Ada')
    await screen.findByRole('button', { name: 'Edit item with id: 1' })
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByRole('button', { name: 'Edit item with id: 3' })
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next page' })).toHaveAttribute('aria-disabled', 'true'))
    await screen.findByRole('button', { name: 'Edit item with id: 3' })
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByRole('button', { name: 'Page 3' })).not.toBeInTheDocument()
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(screen.getByRole('button', { name: 'Edit item with id: 1' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
    expect(screen.getByRole('button', { name: 'Edit item with id: 3' })).toBeInTheDocument()
    expect(fetchMock.mock.calls).toHaveLength(callsBefore)
  })

  it.each(['scan', 'query'] as const)('stops %s at the end when no items match and hides pagination', async (mode) => {
    mockItemPages([[scanPayload.items[1]], [], [scanPayload.items[1]]])
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Grace')
    if (mode === 'query') {
      fireEvent.click(screen.getByText('Query'))
      fireEvent.change(screen.getByRole('textbox', { name: 'Partition key (id)' }), { target: { value: '1' } })
      fireEvent.click(screen.getByRole('button', { name: 'Run query' }))
      await screen.findByText('Grace')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fillFilter(1, 'name', 'Ada')
    await screen.findByText('No items match these filters')
    expect(screen.queryByRole('button', { name: 'Page 1' })).not.toBeInTheDocument()
    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes(mode === 'scan' ? '/items?' : '/query'))
    expect(calls).toHaveLength(3)
  })

  it('restarts changed filters at the first match and reuses skipped pages when filters are cleared', async () => {
    mockItemPages([[scanPayload.items[1]], [scanPayload.items[0]]])
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Grace')
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fillFilter(1, 'name', 'Ada')
    await screen.findByText('Ada')
    const callsBefore = fetchMock.mock.calls.length
    fillFilter(1, 'name', 'Grace')
    await screen.findByText('Grace')
    expect(screen.queryByText('Ada')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await screen.findByText('Grace')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('Ada')
    expect(fetchMock.mock.calls).toHaveLength(callsBefore)
  })

  it('abandons an obsolete filter search without fetching further pages', async () => {
    mockItemPages([[scanPayload.items[1]], [scanPayload.items[0]], [scanPayload.items[0]]])
    const originalFetch = fetchMock.getMockImplementation()!
    let resolvePage!: (response: Response) => void
    fetchMock.mockImplementation((input, init) => String(input).includes('exclusive_start_key=cursor-1')
      ? new Promise((resolve) => { resolvePage = resolve })
      : originalFetch(input, init))
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Grace')
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fillFilter(1, 'name', 'Ada')
    await waitFor(() => expect(resolvePage).toBeDefined())
    fillFilter(1, 'name', 'Grace')
    await screen.findByText('Grace')
    await act(async () => resolvePage({ ok: true, json: () => Promise.resolve({
      ...scanPayload, items: [scanPayload.items[0]], next_token: 'cursor-2',
    }) } as Response))
    expect(screen.getByText('Grace')).toBeInTheDocument()
    expect(screen.queryByText('Ada')).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('exclusive_start_key=cursor-2'))).toBe(false)
  })

  it.each(['scan', 'query'] as const)('paginates %s results and reuses visited pages without carrying selections', async (mode) => {
    const firstPage = { ...scanPayload, items: [scanPayload.items[0]], next_token: 'next', count: 1, scanned_count: 1 }
    mockFetchByUrl({ scanPayload: firstPage, queryPayload: firstPage })
    const originalFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation((input, init) => {
      const token = String(input).includes('/query')
        ? JSON.parse(init!.body as string).exclusive_start_key
        : new URL(String(input), 'http://localhost').searchParams.get('exclusive_start_key')
      if (token === 'next') return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ...scanPayload, items: [scanPayload.items[1]], count: 1, scanned_count: 1 }),
      } as Response)
      return originalFetch(input, init)
    })
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Ada')
    if (mode === 'query') {
      fireEvent.click(screen.getByText('Query'))
      expect(screen.queryByText('Ada')).not.toBeInTheDocument()
      fireEvent.change(screen.getByRole('textbox', { name: 'Partition key (id)' }), { target: { value: '1' } })
      fireEvent.click(screen.getByRole('button', { name: 'Run query' }))
      await screen.findByText('Ada')
    }
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Previous page' })).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(within(screen.getByText('Ada').closest('tr')!).getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('Grace')
    expect(screen.queryByText('Ada')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete selected (0)' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: 'Next page' })).toHaveAttribute('aria-disabled', 'true')
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.queryByText('Grace')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }))
    expect(screen.getByText('Grace')).toBeInTheDocument()
    expect(fetchMock.mock.calls).toHaveLength(callsBefore)
  })

  it.each(['scan', 'query'] as const)('restarts %s pagination when the page size changes or items are refreshed', async (mode) => {
    mockFetchByUrl({ scanPayload: { ...scanPayload, next_token: 'next' }, queryPayload: { ...queryPayload, next_token: 'next' } })
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Ada')
    if (mode === 'query') {
      fireEvent.click(screen.getByText('Query'))
      fireEvent.change(screen.getByRole('textbox', { name: 'Partition key (id)' }), { target: { value: '1' } })
      fireEvent.click(screen.getByRole('button', { name: 'Run query' }))
      await screen.findByText('Ada')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByRole('button', { name: 'Page 2' })
    const trigger = screen.getByRole('button', { name: /Page size/ })
    const select = createWrapper(document.body).findAllSelects().find((candidate) => candidate.findTrigger().getElement() === trigger)!
    act(() => select.openDropdown())
    act(() => select.selectOptionByValue('50'))
    await waitFor(() => {
      const call = fetchMock.mock.calls.filter(([url]) => String(url).includes(mode === 'scan' ? '/items?' : '/query')).at(-1)!
      if (mode === 'scan') {
        const params = new URL(String(call[0]), 'http://localhost').searchParams
        expect(params.get('limit')).toBe('50')
        expect(params.has('exclusive_start_key')).toBe(false)
      } else {
        expect(JSON.parse(call[1]!.body as string)).toMatchObject({ limit: 50, exclusive_start_key: null })
      }
      expect(screen.queryByRole('button', { name: 'Page 2' })).not.toBeInTheDocument()
    })
    await screen.findByText('Ada')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByRole('button', { name: 'Page 2' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload items' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Page 2' })).not.toBeInTheDocument())
    await screen.findByText('Ada')
    expect(screen.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'true')
  })

  it('pages the submitted query and starts over when a different query is run', async () => {
    mockFetchByUrl({ queryPayload: { ...queryPayload, next_token: 'query-next' } })
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Ada')
    fireEvent.click(screen.getByText('Query'))
    const pk = screen.getByRole('textbox', { name: 'Partition key (id)' })
    fireEvent.change(pk, { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }))
    await screen.findByText('Ada')
    fireEvent.change(pk, { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByRole('button', { name: 'Page 2' })
    const queryCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/query'))
    expect(JSON.parse(queryCalls().at(-1)![1]!.body as string)).toMatchObject({
      partition_key_value: '1', exclusive_start_key: 'query-next', limit: 25,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }))
    await waitFor(() => expect(queryCalls()).toHaveLength(3))
    await screen.findByText('Ada')
    expect(JSON.parse(queryCalls().at(-1)![1]!.body as string)).toMatchObject({
      partition_key_value: '2', exclusive_start_key: null,
    })
    expect(screen.queryByRole('button', { name: 'Page 2' })).not.toBeInTheDocument()
  })

  it('keeps the current page after a failed request so Next can be retried', async () => {
    mockFetchByUrl({ scanPayload: { ...scanPayload, next_token: 'next' } })
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Ada')
    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ error: 'Unavailable', items: [] }) } as Response)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('Ada')
    expect(screen.queryByRole('button', { name: 'Page 2' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByRole('button', { name: 'Page 2' })
  })

  it('ignores an in-flight scan page after switching to queries', async () => {
    mockFetchByUrl({ scanPayload: { ...scanPayload, next_token: 'next' } })
    renderDynamo('/resources/dynamodb?table=learners')
    await screen.findByText('Ada')
    let resolvePage!: (response: Response) => void
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { resolvePage = resolve }))
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    fireEvent.click(screen.getByText('Query'))
    await act(async () => resolvePage({ ok: true, json: () => Promise.resolve(scanPayload) } as Response))
    expect(screen.queryByText('Ada')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Page 2' })).not.toBeInTheDocument()
  })
})
