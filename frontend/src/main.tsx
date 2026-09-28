import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// Lets anyone answer "which build is this tab running?" from the console, without a
// bundle-hash hunt. A tab left open across a deploy keeps running the old bundle
// indefinitely, which looks identical to a deploy that never landed — this is the
// cheapest way to tell those two apart.
;(window as unknown as { __BEACON_BUILD__: unknown }).__BEACON_BUILD__ = {
  commit: __BUILD_COMMIT__,
  builtAt: __BUILD_TIME__,
}
console.log(`Beacon build ${__BUILD_COMMIT__} (built ${__BUILD_TIME__})`)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
