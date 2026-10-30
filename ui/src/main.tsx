import React from 'react'
import { createRoot } from 'react-dom/client'
import { FluxApp } from './shell/FluxApp'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <FluxApp />
  </React.StrictMode>,
)
