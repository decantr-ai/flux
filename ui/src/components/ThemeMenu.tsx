import { Popover } from '@base-ui/react/popover'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme, type ThemePreference } from '../lib/theme'
import { Button } from './ui/Button'

const modes = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const

export function ThemeMenu() {
  const { preference, setTheme } = useTheme()
  const CurrentIcon = modes.find(mode => mode.value === preference)!.Icon
  return <Popover.Root>
    <Popover.Trigger render={<Button variant="quiet" size="icon" className="theme-trigger" aria-label={'Appearance: ' + preference} title="Change appearance" />}>
      <CurrentIcon size={17} aria-hidden="true" />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner align="end" sideOffset={8} className="z-[130] outline-none">
        <Popover.Popup className="theme-menu">
          <Popover.Title className="theme-menu-title">Appearance</Popover.Title>
          <div className="theme-options" role="group" aria-label="Color theme">
            {modes.map(({ value, label, Icon }) => <button key={value} type="button" aria-pressed={preference === value} onClick={() => setTheme(value as ThemePreference)} className="theme-option">
              <Icon size={19} aria-hidden="true" /><span>{label}</span>
            </button>)}
          </div>
          <Popover.Description className="theme-menu-description">{preference === 'system' ? 'Follows your device appearance.' : 'Saved for this browser.'}</Popover.Description>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
}
