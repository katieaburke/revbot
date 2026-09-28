import axios, { type AxiosInstance } from 'axios'

const API_BASE = import.meta.env.VITE_API_URL ?? ''

/**
 * 30s default. Without any timeout a request that never answers leaves the calling
 * component spinning forever with no error path — which is precisely how the account
 * scan appeared to "just sit there loading". Long-running work (scans, exports) is
 * polled rather than awaited in one request, so nothing legitimate needs more than
 * this; anything that does can pass its own `timeout` per call.
 */
const TIMEOUT_MS = 30_000

function createClient(baseURL: string): AxiosInstance {
  const client = axios.create({ baseURL, timeout: TIMEOUT_MS })

  // Attach JWT to every request
  client.interceptors.request.use((config) => {
    const token = localStorage.getItem('admin_token')
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  })

  client.interceptors.response.use(
    (res) => res,
    (err) => {
      // Redirect to login on 401
      if (err.response?.status === 401) {
        localStorage.removeItem('admin_token')
        window.location.href = '/login'
      }
      // A timeout arrives with no `response`, so any UI reading `err.response.data.error`
      // shows nothing at all and the failure looks like a blank screen. Give it a
      // message in the shape callers already expect.
      if (err.code === 'ECONNABORTED') {
        err.message = 'The server took too long to respond. It may still be working — try again in a moment.'
      }
      return Promise.reject(err)
    },
  )

  return client
}

/** Everything under /api — the bulk of the admin UI. */
export const api = createClient(API_BASE ? `${API_BASE}/api` : '/api')

/**
 * The /auth router, which is mounted as a sibling of /api rather than beneath it.
 * Its own client instead of path gymnastics like `/../auth/...` against the /api
 * baseURL, which axios resolves inconsistently depending on whether VITE_API_URL is
 * an absolute origin or empty.
 */
export const authApi = createClient(API_BASE ? `${API_BASE}/auth` : '/auth')

export async function login(email: string, password: string) {
  // Bare axios, not a shared client — login must not send a stale Authorization
  // header, and a 401 here means "wrong password", not "session expired", so it must
  // not trip the redirect-to-login interceptor. It still needs the timeout, or a cold
  // backend hangs the login button with no feedback.
  const res = await axios.post(`${API_BASE}/auth/admin/login`, { email, password }, { timeout: TIMEOUT_MS })
  localStorage.setItem('admin_token', res.data.token)
}
