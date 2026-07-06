import { NavLink, Outlet, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Settings,
  BellRing,
  LogOut,
  Timer,
  ClipboardList,
  CalendarX,
  BookOpen,
  Building2,
  ChevronDown,
  ArrowRight,
  AlertTriangle,
  GitCompare,
  Users,
  BarChart2,
} from 'lucide-react'
import clsx from 'clsx'
import { useState } from 'react'
import { useDryRunSummary } from '../hooks/useDryRunSummary'

const PLAYBOOK_ROUTES = ['/stall-rules', '/meddpicc', '/past-due', '/next-step', '/close-date-risk', '/accounts', '/playbook/stage-mismatch', '/playbook/accounts']

export function Layout() {
  const location = useLocation()
  const isInPlaybook = PLAYBOOK_ROUTES.some((r) => location.pathname.startsWith(r))
  const [playbookOpen, setPlaybookOpen] = useState(isInPlaybook)
  const { data: dryRunSummary } = useDryRunSummary()

  function logout() {
    localStorage.removeItem('admin_token')
    window.location.href = '/login'
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-6 py-5 border-b border-gray-200">
          <h1 className="text-lg font-semibold text-gray-900">Beacon</h1>
          <p className="text-xs text-gray-500 mt-0.5">RevOps Admin</p>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">

          {/* Dashboard */}
          <NavItem to="/" label="Dashboard" icon={LayoutDashboard} end />

          {/* Notification History */}
          <NavItem to="/notifications" label="Notification History" icon={BellRing} />

          {/* Analytics */}
          <NavItem to="/analytics" label="Analytics" icon={BarChart2} />

          <div className="pt-2 pb-1">
            <div className="h-px bg-gray-100 mx-1" />
          </div>

          {/* Playbook section */}
          <button
            onClick={() => setPlaybookOpen((o) => !o)}
            className={clsx(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors w-full',
              isInPlaybook
                ? 'bg-brand-50 text-brand-600'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            )}
          >
            <BookOpen size={16} />
            <span className="flex-1 text-left">Playbook</span>
            <ChevronDown
              size={14}
              className={clsx('transition-transform', playbookOpen && 'rotate-180')}
            />
          </button>

          {playbookOpen && (
            <div className="ml-3 pl-3 border-l border-gray-200 space-y-0.5 mt-0.5">

              {/* Pipeline Hygiene sub-section */}
              <p className="px-3 pt-2 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                Pipeline Hygiene
              </p>
              <NavItem to="/stall-rules" label="Zombie Pipeline" icon={Timer} badge={dryRunSummary?.byAlertType['STALLED']} />
              <NavItem to="/meddpicc" label="MEDDPICC + BANT" icon={ClipboardList} badge={dryRunSummary?.byAlertType['MEDDPICC_MISSING']} />
              <NavItem
                to="/past-due"
                label="Past Due"
                icon={CalendarX}
                badge={
                  (dryRunSummary?.byAlertType['PAST_DUE_INITIAL'] ?? 0) +
                  (dryRunSummary?.byAlertType['PAST_DUE_AMENDMENT'] ?? 0) +
                  (dryRunSummary?.byAlertType['PAST_DUE_RENEWAL'] ?? 0) || undefined
                }
              />
              <NavItem to="/next-step" label="Next Step" icon={ArrowRight} badge={dryRunSummary?.byAlertType['NEXT_STEP_MISSING']} />
              <NavItem to="/close-date-risk" label="Close Date Risk" icon={AlertTriangle} badge={dryRunSummary?.byAlertType['CLOSE_DATE_RISK']} />
              <NavItem to="/playbook/stage-mismatch" label="Stage Mismatch" icon={GitCompare} badge={dryRunSummary?.byAlertType['STAGE_MISMATCH']} />

              {/* Prospecting Management sub-section */}
              <p className="px-3 pt-3 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                Prospecting Management
              </p>
              <NavItem to="/playbook/accounts" label="Prospecting Hygiene" icon={Building2} />

              {/* Risk and Termination Management sub-section */}
              <p className="px-3 pt-3 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                Risk &amp; Termination Management
              </p>

              {/* Territory Management sub-section */}
              <p className="px-3 pt-3 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                Territory Management
              </p>

            </div>
          )}

          <div className="pt-2 pb-1">
            <div className="h-px bg-gray-100 mx-1" />
          </div>

          {/* Team */}
          <NavItem to="/team" label="Team" icon={Users} />

          {/* Settings */}
          <NavItem to="/settings" label="Settings" icon={Settings} />

        </nav>

        <div className="px-3 py-4 border-t border-gray-200">
          <button
            onClick={logout}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 w-full"
          >
            <LogOut size={16} />
            Log out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}

function NavItem({
  to,
  label,
  icon: Icon,
  end,
  badge,
}: {
  to: string
  label: string
  icon: React.ElementType
  end?: boolean
  badge?: number
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
          isActive
            ? 'bg-brand-50 text-brand-600'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
        )
      }
    >
      <Icon size={16} />
      <span className="flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto text-xs bg-orange-100 text-orange-700 font-semibold px-1.5 py-0.5 rounded-full">
          {badge}
        </span>
      )}
    </NavLink>
  )
}
