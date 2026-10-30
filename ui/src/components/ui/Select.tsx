import { Select } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface SelectOption { value: string; label: string; disabled?: boolean }

export function UiSelect({ value, onValueChange, options, label, ariaLabel, placeholder }: {
  value: string
  onValueChange: (value: string) => void
  options: SelectOption[]
  label?: string
  ariaLabel?: string
  placeholder?: string
}) {
  const trigger = <Select.Trigger aria-label={ariaLabel} className="select-trigger group">
    <Select.Value placeholder={placeholder ?? 'Choose an option'} className="min-w-0 flex-1 truncate" />
    <Select.Icon className="flex size-5 flex-none items-center justify-center rounded text-muted/80 transition-transform group-data-[popup-open]:rotate-180">
      <ChevronDown aria-hidden="true" size={16} strokeWidth={1.9} />
    </Select.Icon>
  </Select.Trigger>

  return <div className="ui-select-root min-w-0"><Select.Root value={value} onValueChange={next => { if (next !== null) onValueChange(next) }} items={options}>
    {label && <Select.Label className="field-label">{label}</Select.Label>}
    {trigger}
    <Select.Portal>
      <Select.Positioner sideOffset={6} alignItemWithTrigger={false} className="z-[120] outline-none">
        <Select.Popup className="select-popup">
          <Select.List>
            {options.map(option => <Select.Item key={option.value} value={option.value} disabled={option.disabled} className="select-option">
              <Select.ItemIndicator className="inline-flex size-4 flex-none items-center justify-center"><Check size={14} strokeWidth={2} /></Select.ItemIndicator>
              <Select.ItemText className={cn('min-w-0 flex-1 break-words', option.value !== value && 'ml-6')}>
                {option.label}
              </Select.ItemText>
            </Select.Item>)}
          </Select.List>
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root></div>
}
