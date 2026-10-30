// Runs as a same-origin blocking script before styles and React, without relaxing CSP.
;(function () {
  var preference = 'system'
  try {
    var saved = localStorage.getItem('flux:theme')
    if (saved === 'light' || saved === 'dark' || saved === 'system') preference = saved
  } catch (_) { /* storage is optional */ }
  var dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.themePreference = preference
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
})()
