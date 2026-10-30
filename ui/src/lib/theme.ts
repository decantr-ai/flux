import { useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'
const isPreference = (value: unknown): value is ThemePreference => value === 'light' || value === 'dark' || value === 'system'

function applyTheme(preference: ThemePreference) {
  const resolved = preference === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference
  document.documentElement.dataset.theme = resolved
  document.documentElement.dataset.themePreference = preference
  document.documentElement.style.colorScheme = resolved
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#101014' : '#f4f1ed')
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const initial = document.documentElement.dataset.themePreference
    return isPreference(initial) ? initial : 'system'
  })

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => applyTheme(preference)
    const sync = (event: StorageEvent) => {
      if (event.key === 'flux:theme' || event.key === null) {
        setPreference(isPreference(event.newValue) ? event.newValue : 'system')
      }
    }
    update()
    media.addEventListener('change', update)
    window.addEventListener('storage', sync)
    return () => {
      media.removeEventListener('change', update)
      window.removeEventListener('storage', sync)
    }
  }, [preference])

  function setTheme(value: ThemePreference) {
    applyTheme(value)
    setPreference(value)
    try { localStorage.setItem('flux:theme', value) } catch { /* keep the in-memory choice */ }
  }

  return { preference, setTheme }
}
