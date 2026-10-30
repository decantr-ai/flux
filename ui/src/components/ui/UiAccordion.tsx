import { Accordion } from '@base-ui/react/accordion'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface AccordionSection { value: string; title: React.ReactNode; children: React.ReactNode; className?: string }

export function UiAccordion({ sections, multiple = true, className, defaultValue }: { sections: AccordionSection[]; multiple?: boolean; className?: string; defaultValue?: string[] }) {
  return <Accordion.Root defaultValue={defaultValue} multiple={multiple} className={cn('ui-accordion min-w-0 divide-y divide-line', className)}>
    {sections.map(section => <Accordion.Item key={section.value} value={section.value} className={section.className}>
      <Accordion.Header>
        <Accordion.Trigger className="accordion-trigger group">
          <ChevronDown aria-hidden="true" size={16} className="flex-none text-muted transition-transform group-data-[panel-open]:rotate-180" />
          <span className="accordion-label">{section.title}</span>
        </Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Panel className="overflow-hidden pb-3">
        <div className="pt-1">{section.children}</div>
      </Accordion.Panel>
    </Accordion.Item>)}
  </Accordion.Root>
}
