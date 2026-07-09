import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { Trash2, KeyRound, UserPlus, X, Link, Copy, Check } from 'lucide-react'

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

  // ── Rep link generator ──────────────────────────────────────────────────────
  const [repEmail, setRepEmail] = useState('')
  const [generatedLink, setGeneratedLink] = useState<{ url: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [repLinkError, setRepLinkError] = useState('')

  const generateLink = useMutation({
    mutationFn: (email: string) =>
      api.post('/rep/admin/generate-link', { email }).then((r) => {
        const { token, name } = r.data as { token: string; name: string }
        return { url: `${window.location.origin}/my-flags?token=${token}`, name }
      }),
    onSuccess: (data) => {
      setGeneratedLink(data)
      setRepLinkError('')
    },
    onError: (err: any) => {
      setRepLinkError(err.response?.data?.error ?? "Rep not found — make sure they've received at least one RevBot message")
      setGeneratedLink(null)
    },
  })

  function handleGenerateLink(e: React.FormEvent) {
    e.preventDefault()
    setGeneratedLink(null)
    setCopied(false)
    generateLink.mutate(repEmail)
  }

  function copyLink() {
    if (!generatedLink) return
    navigator.clipboard.writeText(generatedLink.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // ── Manager link generator ───────────────────────────────────────────────────
  const [managerEmail, setManagerEmail] = useState('')
  const [generatedManagerLink, setGeneratedManagerLink] = useState<{ url: string; name: string } | null>(null)
  const [managerCopied, setManagerCopied] = useState(false)
  const [managerLinkError, setManagerLinkError] = useState('')

  const generateManagerLink = useMutation({
    mutationFn: (email: string) =>
      api.post('/manager/admin/generate-link', { email }).then((r) => {
        const { token, name } = r.data as { token: string; name: string }
        return { url: `${window.location.origin}/my-team?token=${token}`, name }
      }),
    onSuccess: (data) => {
      setGeneratedManagerLink(data)
      setManagerLinkError('')
    },
    onError: (err: any) => {
      setManagerLinkError(err.response?.data?.error ?? "Manager not found — make sure they're in the system")
      setGeneratedManagerLink(null)
    },
  })

  function handleGenerateManagerLink(e: React.FormEvent) {
    e.preventDefault()
    setGeneratedManagerLink(null)
    setManagerCopied(false)
    generateManagerLink.mutate(managerEmail)
  }

  function copyManagerLink() {
    if (!generatedManagerLink) return
    navigator.clipboard.writeText(generatedManagerLink.url)
    setManagerCopied(true)
    setTimeout(() => setManagerCopied(false), 2000)
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

      {/* ── Rep portal link generator ──────────────────────────────────────────── */}
      <div className="mt-10">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Rep portal links</h3>
        <p className="text-sm text-gray-500 mb-5">
          Generate a magic link for any rep to see their open RevBot flags. Valid for 30 days.
        </p>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <form onSubmit={handleGenerateLink} className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">Rep email</label>
              <input
                type="email"
                required
                value={repEmail}
                onChange={(e) => { setRepEmail(e.target.value); setGeneratedLink(null); setRepLinkError('') }}
                className="input w-full"
                placeholder="rep@uberall.com"
              />
            </div>
            <button
              type="submit"
              disabled={generateLink.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50 whitespace-nowrap"
            >
              <Link size={14} />
              {generateLink.isPending ? 'Generating…' : 'Generate link'}
            </button>
          </form>

          {repLinkError && (
            <p className="mt-3 text-xs text-red-600">{repLinkError}</p>
          )}

          {generatedLink && (
            <div className="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-xs font-medium text-gray-700">{generatedLink.name}</span>
                <button
                  onClick={copyLink}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-white transition-colors"
                >
                  {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
              </div>
              <p className="text-xs text-gray-400 truncate">{generatedLink.url}</p>
            </div>
          )}
        </div>
      </div>

      {/* ── Manager portal link generator ─────────────────────────────────────── */}
      <div className="mt-10">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Manager portal links</h3>
        <p className="text-sm text-gray-500 mb-5">
          Generate a magic link for a manager to see their team's open RevBot flags. Valid for 30 days.
        </p>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <form onSubmit={handleGenerateManagerLink} className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-700 mb-1">Manager email</label>
              <input
                type="email"
                required
                value={managerEmail}
                onChange={(e) => { setManagerEmail(e.target.value); setGeneratedManagerLink(null); setManagerLinkError('') }}
                className="input w-full"
                placeholder="manager@uberall.com"
              />
            </div>
            <button
              type="submit"
              disabled={generateManagerLink.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-brand-500 text-white text-sm font-medium rounded-lg hover:bg-brand-600 disabled:opacity-50 whitespace-nowrap"
            >
              <Link size={14} />
              {generateManagerLink.isPending ? 'Generating…' : 'Generate link'}
            </button>
          </form>

          {managerLinkError && (
            <p className="mt-3 text-xs text-red-600">{managerLinkError}</p>
          )}

          {generatedManagerLink && (
            <div className="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-xs font-medium text-gray-700">{generatedManagerLink.name}</span>
                <button
                  onClick={copyManagerLink}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-white transition-colors"
                >
                  {managerCopied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                  {managerCopied ? 'Copied!' : 'Copy link'}
                </button>
              </div>
              <p className="text-xs text-gray-400 truncate">{generatedManagerLink.url}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
