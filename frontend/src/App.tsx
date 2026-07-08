import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Notifications } from './pages/Notifications'
import { StallConfig } from './pages/StallConfig'
import { MeddpiccConfig } from './pages/MeddpiccConfig'
import { PastDueConfig } from './pages/PastDueConfig'
import { NextStepConfig } from './pages/NextStepConfig'
import { CloseDateConfig } from './pages/CloseDateConfig'
import { StageMismatchConfig } from './pages/StageMismatchConfig'
import { Settings } from './pages/Settings'
import { Team } from './pages/Team'
import { Analytics } from './pages/Analytics'
import { ProspectingHygiene } from './pages/ProspectingHygiene'
import { TerritoryReassignment } from './pages/TerritoryReassignment'
import { ChurnedReassignment } from './pages/ChurnedReassignment'
import { RepPortal } from './pages/RepPortal'

const qc = new QueryClient()

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('admin_token')
  if (!token) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  // Rep portal is fully public — bypass the admin router entirely
  if (window.location.pathname.startsWith('/my-flags')) {
    return (
      <QueryClientProvider client={qc}>
        <RepPortal />
      </QueryClientProvider>
    )
  }

  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/stall-rules" element={<StallConfig />} />
            <Route path="/meddpicc" element={<MeddpiccConfig />} />
            <Route path="/past-due" element={<PastDueConfig />} />
            <Route path="/next-step" element={<NextStepConfig />} />
            <Route path="/close-date-risk" element={<CloseDateConfig />} />
            <Route path="/playbook/stage-mismatch" element={<StageMismatchConfig />} />
            <Route path="/playbook/accounts" element={<ProspectingHygiene />} />
            <Route path="/playbook/territory/newlogos" element={<TerritoryReassignment />} />
            <Route path="/playbook/territory/churned" element={<ChurnedReassignment />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/team" element={<Team />} />
            <Route path="/analytics" element={<Analytics />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
