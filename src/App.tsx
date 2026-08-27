import { Navigate, Route, Routes } from 'react-router-dom'

import { Admin } from './screens/Admin'
import { Home } from './screens/Home'
import { Join } from './screens/Join'
import { Lobby } from './screens/Lobby'
import { Results } from './screens/Results'
import { Swipe } from './screens/Swipe'
import { Waiting } from './screens/Waiting'

/**
 * Routes are exactly the seven in PLAN.md §9. The resume state machine
 * (resolveRoute) arrives in phase 5 — until then these are reachable
 * directly and render placeholders.
 */
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/join" element={<Join />} />
      <Route path="/lobby/:code" element={<Lobby />} />
      <Route path="/swipe/:sessionId" element={<Swipe />} />
      <Route path="/waiting/:sessionId" element={<Waiting />} />
      <Route path="/results/:sessionId" element={<Results />} />
      <Route path="/admin" element={<Admin />} />

      {/* No 404 screen in the design. Anything unknown goes home. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
