import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const initializer = readFileSync(new URL('../ui/src/theme-init.js', import.meta.url), 'utf8')
function beforePaint(saved, systemDark, blockedStorage = false) {
  const document = { documentElement: { dataset: {}, style: {} } }
  runInNewContext(initializer, {
    document,
    matchMedia: query => { assert.equal(query, '(prefers-color-scheme: dark)'); return { matches: systemDark } },
    localStorage: { getItem(key) { assert.equal(key, 'flux:theme'); if (blockedStorage) throw new Error('Unavailable'); return saved } },
  })
  return document.documentElement
}

test('first paint follows the system when no appearance was chosen', () => {
  for (const dark of [false, true]) {
    const result = beforePaint(null, dark)
    assert.equal(result.dataset.themePreference, 'system')
    assert.equal(result.dataset.theme, dark ? 'dark' : 'light')
    assert.equal(result.style.colorScheme, result.dataset.theme)
  }
})

test('an explicit appearance overrides the opposite system setting on reload', () => {
  assert.equal(beforePaint('light', true).dataset.theme, 'light')
  assert.equal(beforePaint('dark', false).dataset.theme, 'dark')
})

test('invalid or inaccessible storage falls back to the device appearance', () => {
  assert.equal(beforePaint('obsolete-choice', true).dataset.theme, 'dark')
  assert.equal(beforePaint('light', true, true).dataset.theme, 'dark')
})
