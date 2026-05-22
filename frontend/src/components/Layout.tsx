import { NavLink, Outlet } from 'react-router-dom'
import { LayoutDashboard, AlertTriangle, Settings, BellRing, LogOut } from 'lucide-react'
import clsx from 'clsx'

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/notifications', label: 'Notifications', icon: BellRing },
  { to: '/stall-rules', label: 'Stall Rules', icon: AlertTriangle },
  { to: '/meddpicc', label: 'MEDDPICC Config', icon: Settings },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export function Layout() {
  function logout() {
    localStorage.removeItem('admin_token')
    window.location.href = '/login'
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-60 bg-white border-r border-gray-200 flex flex-col">
        <div className="px-6 py-5 border-b border-gray-200">
          <h1 className="text-lg font-semibold text-gray-900">Pipeline Nudge</h1>
          <p className="text-xs text-gray-500 mt-0.5">RevOps Admin</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
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
              {label}
            </NavLink>
          ))}
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
