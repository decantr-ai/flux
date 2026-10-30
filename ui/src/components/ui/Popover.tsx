import { Popover } from '@base-ui/react/popover'
import type { ReactNode } from 'react'

export function FilterPopover({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return <Popover.Root>
    <Popover.Trigger aria-label="Filters" className="button button-quiet top-action">{trigger}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner align="end" sideOffset={8} className="z-[80] outline-none">
        <Popover.Popup className="filter-popover">{children}</Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
