import AttributeEditor from '@cloudscape-design/components/attribute-editor'
import Autosuggest from '@cloudscape-design/components/autosuggest'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Checkbox from '@cloudscape-design/components/checkbox'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import SegmentedControl from '@cloudscape-design/components/segmented-control'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import {
  ITEM_FILTER_OPERATORS,
  type DynamoDBItemFilter,
  type ItemFilterMatchMode,
  type ItemFilterOperator,
} from '@/lib/dynamodb-item-filters'

interface Props {
  columns: string[]
  filters: DynamoDBItemFilter[]
  matchMode: ItemFilterMatchMode
  caseSensitive: boolean
  onChange: (filters: DynamoDBItemFilter[]) => void
  onMatchModeChange: (mode: ItemFilterMatchMode) => void
  onCaseSensitiveChange: (value: boolean) => void
}

export function DynamoDBItemFilters({
  columns, filters, matchMode, caseSensitive, onChange, onMatchModeChange, onCaseSensitiveChange,
}: Props) {
  const update = (index: number, changes: Partial<DynamoDBItemFilter>) => {
    onChange(filters.map((filter, i) => i === index ? { ...filter, ...changes } : filter))
  }

  return (
    <SpaceBetween size="s">
      <Header variant="h3" description="Filtered pages fill up to the selected page size. All comparisons use text, including numbers.">
        Filters <Box variant="span" color="text-body-secondary">(optional)</Box>
      </Header>
      <AttributeEditor
        items={filters}
        empty={<Box color="text-body-secondary">No filters applied</Box>}
        addButtonText="Add filter"
        removeButtonText="Remove"
        removeButtonAriaLabel={(filter) => `Remove filter ${filters.indexOf(filter) + 1}`}
        onAddButtonClick={() => onChange([...filters, { column: '', operator: 'contains', value: '' }])}
        onRemoveButtonClick={({ detail }) => onChange(filters.filter((_, index) => index !== detail.itemIndex))}
        additionalInfo={filters.length > 0 ? 'Complete both column and search text to apply a filter.' : undefined}
        additionalActions={filters.length > 0 ? (
          <SpaceBetween direction="horizontal" size="s">
            {filters.length > 1 && (
              <SegmentedControl
                label="Combine filters"
                selectedId={matchMode}
                onChange={({ detail }) => onMatchModeChange(detail.selectedId as ItemFilterMatchMode)}
                options={[{ id: 'all', text: 'All filters' }, { id: 'any', text: 'Any filter' }]}
              />
            )}
            <Checkbox checked={caseSensitive} onChange={({ detail }) => onCaseSensitiveChange(detail.checked)}>
              Match case
            </Checkbox>
            <Button variant="link" onClick={() => onChange([])}>Clear filters</Button>
          </SpaceBetween>
        ) : undefined}
        definition={[
          {
            label: 'Column name',
            control: (filter, index) => (
              <Autosuggest
                value={filter.column}
                onChange={({ detail }) => update(index, { column: detail.value })}
                options={columns.map((column) => ({ value: column }))}
                enteredTextLabel={(value) => `Use "${value}"`}
                selectedAriaLabel="Selected"
                ariaLabel={`Filter ${index + 1} column`}
                placeholder="Type a column name"
              />
            ),
          },
          {
            label: 'Comparison',
            control: (filter, index) => (
              <Select
                selectedOption={ITEM_FILTER_OPERATORS.find((option) => option.value === filter.operator) ?? ITEM_FILTER_OPERATORS[0]}
                options={ITEM_FILTER_OPERATORS}
                onChange={({ detail }) => update(index, { operator: detail.selectedOption.value as ItemFilterOperator })}
                ariaLabel={`Filter ${index + 1} comparison`}
              />
            ),
          },
          {
            label: 'Search text',
            control: (filter, index) => (
              <Input
                value={filter.value}
                onChange={({ detail }) => update(index, { value: detail.value })}
                ariaLabel={`Filter ${index + 1} search text`}
                placeholder="Text to match"
              />
            ),
          },
        ]}
      />
    </SpaceBetween>
  )
}
