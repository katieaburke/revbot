import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Trash2, KeyRound, UserPlus, X } from 'lucide-react'

interface AdminUser {
  id: string
  email: string
  name: string | null
  createdAt: string
}

export function Team() {
  const qc = useQueryClient()

  const { data: users = [], isLoading } = useQuery<AdminUser[]>({
    queryKey: ['admin-users'],
    queryFn: () => api.get('/config/admin-users').then((r) => r.data),
  })

  // ── Add form state ──────────────────────────────────────────────────────────
  const [showAddForm, setShowAddForm] = useState(false)
  const [addName, setAddName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [addPassword, setAddPassword] = useState('')
  const [addConfirm, setAddConfirm] = useState('')
  const [addError, setAddError] = useState('')

  const addUser = useMutation({
    mutationFn: (data: { email: string; password: string; name?: string }) =>
      api.post('/config/admin-users', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] })
      setShowAddForm(false)
      setAddName('')
      setAddEmail('')
      setAddPassword('')
      setAddConfirm('')
      setAddError('')
    },
    onError: (err: any) => {
      setAddError(err.response?.data?.error ?? 'Failed to add user')
    },
  })

  function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setAddError('')
    if (addPassword.length < 8) {
      setAddError('Password must be at least 8 characters')
      return
    }
    if (addPassword !== addConfirm) {
      setAddError('Passwords do not match')
      return
    }
    addUser.mutate({ email: addEmail, password: addPassword, name: addName || undefined })
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  const deleteUser = useMutation({
    mutationFn: (id: string) => api.delete(`/config/admin-users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  })

  function handleDelete(user: AdminUser) {
    if (!window.confirm(`Remove ${user.email} from admin access? This cannot be undone.`)) return
    deleteUser.mutate(user.id)
  }

  // ── Reset password state ────────────────────────────────────────────────────
  const [resetUserId, setResetUserId] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetConfirm, setResetConfirm] = useState('')
  const [resetError, setResetError] = useState('')

  const resetPassword_ = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.put(`/config/admin-users/${id}/password`, { password }),
    onSuccess: () => {
      setResetUserId(null)
      setResetPassword('')
      setResetConfirm('')
      setResetError('')
    },
    onError: (err: any) => {
      setResetError(err.response?.data?.error ?? 'Failed to reset password')
    },
  })

  function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setResetError('')
    if (resetPassword.length < 8) {
      setResetError('Password must be at least 8 characters')
      return
    }
    if (resetPassword !== resetConfirm) {
      setResetError('Passwords do not match')
      return
    }
    resetPassword_.mutate({ id: resetUserId!, password: resetPassword })
  }

  if (isLoading) return <div className="p-8 text-sm text-gray-400">Loading...</div>

  return (
    <div className="p-8 max-w-2xl">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-2xl font-semibold text-gray-900">Team</h2>
        {!showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600"
          >
            <UserPlus size={15} />
            Add teammate
          </button>
        )}
      </div>
      <p className="text-sm text-gray-500 mb-8">Manage who has access to this admin panel</p>

      {/* ── Add form ──────────────────────────────────────────────────────────── */}
      {showAddForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-900 text-sm">Add teammate</h3>
            <button
              onClick={() => { setShowAddForm(false); setAddError('') }}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={16} />
            </button>
          </div>
          <form onSubmit={handleAdd} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-0.5">Name (optional)</label>
              <input
                type="text"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                className="input w-full"
                placeholder="e.g. Jane Smith"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-0.5">Email</label>
              <input
                type="email"
                required
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                className="input w-full"
                placeholder="jane@example.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-0.5">Password</label>
              <input
                type="password"
                required
                value={addPassword}
                onChange={(e) => setAddPassword(e.target.value)}
                className="input w-full"
                placeholder="Min 8 characters"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-0.5">Confirm password</label>
              <input
                type="password"
                required
                value={addConfirm}
                onChange={(e) => setAddConfirm(e.target.value)}
                className="input w-full"
                placeholder="Re-enter password"
              />
            </div>
            {addError && (
              <p className="text-xs text-red-600">{addError}</p>
            )}
            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={addUser.isPending}
                className="px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
              >
                {addUser.isPending ? 'Adding...' : 'Add teammate'}
              </button>
              <button
                type="button"
                onClick={() => { setShowAddForm(false); setAddError('') }}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── User table ────────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {users.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-gray-400">
            No additional admins yet. Add a teammate to get started.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Added</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((user) => (
                <>
                  <tr key={user.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{user.name ?? <span className="text-gray-400 italic">—</span>}</td>
                    <td className="px-4 py-3 text-gray-700">{user.email}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(user.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => {
                            if (resetUserId === user.id) {
                              setResetUserId(null)
                            } else {
                              setResetUserId(user.id)
                              setResetPassword('')
                              setResetConfirm('')
                              setResetError('')
                            }
                          }}
                          className="p-1.5 text-gray-400 hover:text-brand-600 hover:bg-brand-50 rounded-lg transition-colors"
                          title="Reset password"
                        >
                          <KeyRound size={14} />
                        </button>
                        <button
                          onClick={() => handleDelete(user)}
                          disabled={deleteUser.isPending}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                          title="Remove"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {resetUserId === user.id && (
                    <tr key={`${user.id}-reset`} className="bg-gray-50">
                      <td colSpan={4} className="px-4 py-4">
                        <form onSubmit={handleReset} className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-0.5">New password</label>
                            <input
                              type="password"
                              required
                              value={resetPassword}
                              onChange={(e) => setResetPassword(e.target.value)}
                              className="input w-44"
                              placeholder="Min 8 characters"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-700 mb-0.5">Confirm</label>
                            <input
                              type="password"
                              required
                              value={resetConfirm}
                              onChange={(e) => setResetConfirm(e.target.value)}
                              className="input w-44"
                              placeholder="Re-enter"
                            />
                          </div>
                          <div className="flex gap-2 items-center">
                            <button
                              type="submit"
                              disabled={resetPassword_.isPending}
                              className="px-3 py-2 bg-brand-500 text-white text-xs font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50"
                            >
                              {resetPassword_.isPending ? 'Saving...' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setResetUserId(null); setResetError('') }}
                              className="px-3 py-2 text-xs text-gray-600 border border-gray-200 rounded-lg hover:bg-white"
                            >
                              Cancel
                            </button>
                            {resetError && <p className="text-xs text-red-600">{resetError}</p>}
                            {resetPassword_.isSuccess && <p className="text-xs text-green-600">Password updated</p>}
                          </div>
                        </form>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
