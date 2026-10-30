import { Tabs } from '@base-ui/react/tabs'
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface TabDefinition { id: string; label: string; icon: ReactNode }

export function UiTabs({ value, onValueChange, tabs, panels, className }: {
  value: string
  onValueChange: (value: string) => void
  tabs: TabDefinition[]
  panels: Record<string, ReactNode>
  className?: string
}) {
  return <Tabs.Root value={value} onValueChange={onValueChange} className={cn('min-w-0', className)}>
    <Tabs.List aria-label="Work views" className="tabs-list">
      {tabs.map(tab => <Tabs.Tab key={tab.id} value={tab.id} className="tab-trigger">
        {tab.icon}<span>{tab.label}</span>
      </Tabs.Tab>)}
      <Tabs.Indicator className="tab-indicator" />
    </Tabs.List>
    {tabs.map(tab => <Tabs.Panel key={tab.id} value={tab.id} className="tab-panel">{panels[tab.id]}</Tabs.Panel>)}
  </Tabs.Root>
}
