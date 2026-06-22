import axios from 'axios'

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api' })

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Redirect to login on 401
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('admin_token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export async function login(email: string, password: string) {
  const base = import.meta.env.VITE_API_URL ?? ''
  const res = await axios.post(`${base}/auth/admin/login`, { email, password })
  localStorage.setItem('admin_token', res.data.token)
}
